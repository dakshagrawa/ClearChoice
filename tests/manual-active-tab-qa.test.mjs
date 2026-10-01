// @vitest-environment node
/* global window */
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, expect, test, vi } from 'vitest';
import * as artifacts from '../scripts/release-artifact.mjs';
import {
  assertFixtureOrigin,
  captureIntegrityBaseline,
  createManualActiveTabQaMarker,
  fixtureOriginForServerAddress,
  fixtureForRequest,
  integrityPassed,
  restrictedBrowserArgs,
  reviewBrowserLaunchOptions,
  runManualActiveTabQa,
  runManualCheckpoints,
  runCleanupSteps,
  serveFixture,
} from '../scripts/manual-active-tab-qa.mjs';

const root = resolve(process.cwd());
const temporaryPaths = [];

function listen(host, port, body) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end(body);
  });
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveListen({
      server,
      get requests() { return requests; },
      origin: `http://${host}:${server.address().port}`,
    }));
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('manual checkpoints gate dynamic and reopened Analyze behind Escape detach and pointer Restore confirmation', async () => {
  const events = [];
  let releaseCleanEscape;
  let releaseCleanRestore;
  let releaseDynamicRestore;
  const cleanEscape = new Promise((resolve) => { releaseCleanEscape = resolve; });
  const cleanRestore = new Promise((resolve) => { releaseCleanRestore = resolve; });
  const dynamicRestore = new Promise((resolve) => { releaseDynamicRestore = resolve; });
  const run = runManualCheckpoints({
    cleanPage: 'clean', getDynamicPage: () => 'dynamic',
    instruct: (text) => { events.push(text); },
    waitForPanel: async (page, state) => {
      events.push(`${page}:${state}`);
      if (page === 'clean' && state === 'detached') await cleanEscape;
    },
    assertIntegrity: async (_page, phase) => { events.push(`integrity:${phase}`); },
    confirmRestore: async (page) => {
      events.push(`restore:${page}`);
      if (page === 'clean') await cleanRestore;
      if (page === 'dynamic' && events.filter((event) => event === 'restore:dynamic').length === 1) await dynamicRestore;
    },
    openDynamic: async () => { events.push('open:dynamic'); },
    waitForReplacement: async () => { events.push('replacement'); },
    confirmRepeatedAnalyze: async () => { events.push('repeated'); },
  });
  await vi.waitFor(() => expect(events).toContain('clean:detached'));
  expect(events).not.toContain('open:dynamic');
  expect(events.filter((event) => /^\d+\./.test(event))).toHaveLength(2);
  releaseCleanEscape();
  await vi.waitFor(() => expect(events).toContain('restore:clean'));
  expect(events).not.toContain('open:dynamic');
  expect(events.filter((event) => /^\d+\./.test(event))).toHaveLength(3);
  releaseCleanRestore();
  await vi.waitFor(() => expect(events).toContain('restore:dynamic'));
  expect(events).not.toContain('repeated');
  expect(events.filter((event) => event === 'dynamic:attached')).toHaveLength(1);
  expect(events.filter((event) => /^\d+\./.test(event))).toHaveLength(6);
  releaseDynamicRestore();
  await run;
  const instructions = events.filter((event) => /^\d+\./.test(event));
  expect(instructions.map((line) => Number(line.split('.')[0]))).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  expect(instructions[2]).toContain('Restore');
  expect(instructions[5]).toContain('Restore');
  expect(instructions[6]).toContain('Analyze');
  expect(events.filter((event) => event === 'restore:dynamic')).toHaveLength(2);
  expect(events.filter((event) => event === 'dynamic:attached')).toHaveLength(3);
  expect(events.indexOf('restore:clean')).toBeLessThan(events.indexOf('open:dynamic'));
  expect(events.indexOf('dynamic:detached')).toBeLessThan(events.indexOf('restore:dynamic'));
  expect(events.at(-1)).toBe('integrity:dynamic-fixture Restore/repeated Analyze/replacement');
});

test('manual runner loads the prepared archive extraction and cleans it after browser launch failure', async () => {
  const extensionPath = resolve(tmpdir(), 'synthetic-unit-extracted-extension');
  const cleanup = vi.fn();
  const prepared = vi.spyOn(artifacts, 'prepareCandidateArchive').mockReturnValue({ extensionPath, cleanup });
  const failure = new Error('intentional unit browser-launch stop; no human QA');
  const launch = vi.spyOn(chromium, 'launchPersistentContext').mockRejectedValue(failure);
  try {
    await expect(runManualActiveTabQa([])).rejects.toBe(failure);
    expect(prepared).toHaveBeenCalledExactlyOnceWith(root);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][1]).toEqual(reviewBrowserLaunchOptions(extensionPath));
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    launch.mockRestore();
    prepared.mockRestore();
  }
});

test('manual QA cleanup attempts every resource even when Chromium close rejects', async () => {
  const firstFailure = new Error('Chromium close failed');
  const closeTerminal = vi.fn();
  const closeBrowser = vi.fn().mockRejectedValue(firstFailure);
  const closeFixtureServer = vi.fn();
  const removeProfile = vi.fn();
  await expect(runCleanupSteps([closeTerminal, closeBrowser, closeFixtureServer, removeProfile])).rejects.toBe(firstFailure);
  for (const cleanup of [closeTerminal, closeBrowser, closeFixtureServer, removeProfile]) {
    expect(cleanup).toHaveBeenCalledOnce();
  }
});

test('serves separate clean and dynamic fake checkout fixtures for manual integrity QA', () => {
  expect(fixtureForRequest('/checkout/clean')).toBe('clean');
  expect(fixtureForRequest('/checkout/dynamic-beta')).toBe('dynamic');
  expect(() => fixtureForRequest('/')).toThrow('unknown manual QA fixture request');
});

test('responds once with a 404 for incidental manual-runner requests', () => {
  const response = { writeHead: vi.fn(), end: vi.fn() };
  serveFixture('/favicon.ico', response, { clean: 'clean', dynamic: 'dynamic' });
  expect(response.writeHead).toHaveBeenCalledExactlyOnceWith(404, { 'content-type': 'text/plain; charset=utf-8' });
  expect(response.end).toHaveBeenCalledExactlyOnceWith('not found');
});

test('responds once with the requested manual fixture', () => {
  const response = { writeHead: vi.fn(), end: vi.fn() };
  const cleanFixture = 'clean';
  serveFixture('/checkout/clean', response, { clean: cleanFixture, dynamic: 'dynamic' });
  expect(response.writeHead).toHaveBeenCalledExactlyOnceWith(200, { 'content-type': 'text/html; charset=utf-8' });
  expect(response.end).toHaveBeenCalledExactlyOnceWith(cleanFixture);
});

test('derives the navigated fixture origin only from the runner-owned 127.0.0.1 listener', () => {
  expect(fixtureOriginForServerAddress({ address: '127.0.0.1', port: 43123 })).toBe('http://127.0.0.1:43123');
  expect(() => fixtureOriginForServerAddress({ address: '127.0.0.2', port: 43123 })).toThrow('fixture server must bind exactly to 127.0.0.1');
  expect(() => fixtureOriginForServerAddress({ address: '127.0.0.1', port: 0 })).toThrow('fixture server did not expose a valid TCP port');
});

test('restricts review Chromium to only its 127.0.0.1 fixture and disables implicit loopback bypass', () => {
  const extensionPath = resolve(root, 'dist');
  expect(restrictedBrowserArgs(extensionPath)).toEqual([
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>;127.0.0.1',
    '--disable-quic',
  ]);
  expect(reviewBrowserLaunchOptions(extensionPath)).toEqual({
    channel: 'chromium',
    headless: false,
    args: restrictedBrowserArgs(extensionPath),
  });
  expect(() => assertFixtureOrigin('http://127.0.0.1:43123')).not.toThrow();
  for (const origin of ['http://localhost:43123', 'http://127.0.0.2:43123', 'https://127.0.0.1:43123', 'http://127.0.0.1:0']) {
    expect(() => assertFixtureOrigin(origin)).toThrow('fixture origin must be exactly http://127.0.0.1:<port>');
  }
});

test('retains digest and boolean predicates only, and detects a changed host field', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form action="https://fixture.invalid/checkout"><input name="email" value="fixture@example.invalid"></form>
      <button type="button">Continue</button><a href="/terms">Terms</a>
    `);

    await captureIntegrityBaseline(page);
    const retainedState = await page.evaluate(() => window.__clearchoiceManualIntegrityBaseline);
    expect(Object.keys(retainedState).sort()).toEqual(['digest', 'predicates']);
    expect(Object.keys(retainedState.predicates)).toEqual(['integrity']);
    expect(retainedState.predicates.integrity).toBe(true);
    expect(retainedState.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(retainedState)).not.toContain('fixture@example.invalid');
    expect(JSON.stringify(retainedState)).not.toContain('fixture.invalid');

    await page.locator('input').fill('changed@example.invalid');
    await expect(integrityPassed(page)).resolves.toBe(false);
    await expect(page.evaluate(() => window.__clearchoiceManualIntegrityBaseline.predicates.integrity)).resolves.toBe(false);

    const outputMarker = createManualActiveTabQaMarker({ commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), archiveSha256: 'c'.repeat(64) });
    expect(Object.keys(outputMarker).sort()).toEqual([
      'accessibility',
      'archiveSha256',
      'cleanFixtureIntegrity',
      'commit',
      'dynamicFixtureIntegrity',
      'manifestSha256',
      'outcome',
      'reviewer',
      'schemaVersion',
    ]);
  } finally {
    await browser.close();
  }
});

test('manual runner never writes a caller-provided marker below an external parent symlink to the repository', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-marker-parent-symlink-'));
  temporaryPaths.push(markerDirectory);
  const markerParent = resolve(markerDirectory, 'marker-parent');
  const repositoryTarget = resolve(root, '.manual-active-tab-qa-parent-symlink.json');
  const markerPath = resolve(markerParent, 'manual-active-tab-qa.json');
  await symlink(root, markerParent);

  await expect(runManualActiveTabQa(['--marker', markerPath])).rejects.toThrow('usage: node scripts/manual-active-tab-qa.mjs');
  await expect(lstat(repositoryTarget)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('manual runner never writes a caller-provided marker after its external parent is swapped to the repository', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-marker-parent-swap-'));
  temporaryPaths.push(markerDirectory);
  const markerParent = resolve(markerDirectory, 'marker-parent');
  const repositoryTarget = resolve(root, '.manual-active-tab-qa-parent-swap.json');
  const markerPath = resolve(markerParent, 'manual-active-tab-qa.json');
  await mkdir(markerParent);
  await rm(markerParent, { recursive: true });
  await symlink(root, markerParent);

  await expect(runManualActiveTabQa(['--marker', markerPath])).rejects.toThrow('usage: node scripts/manual-active-tab-qa.mjs');
  await expect(lstat(repositoryTarget)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('Chromium reaches the exact fixture but cannot reach 127.0.0.2 or a non-loopback address', async () => {
  const fixture = await listen('127.0.0.1', 0, 'fixture');
  const alternate = await listen('127.0.0.2', fixture.server.address().port, 'alternate');
  const profile = await mkdtemp(resolve(tmpdir(), 'clearchoice-proxy-boundary-'));
  temporaryPaths.push(profile);
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: restrictedBrowserArgs(resolve(root, 'dist')),
    });
    const page = await browser.newPage();
    await expect(page.goto(fixture.origin, { timeout: 5_000 })).resolves.toBeTruthy();
    await expect(page.goto(alternate.origin, { timeout: 5_000 })).rejects.toThrow();
    await expect(page.goto('http://198.51.100.1:8080/', { timeout: 5_000 })).rejects.toThrow();
    expect(fixture.requests).toBeGreaterThan(0);
    expect(alternate.requests).toBe(0);
  } finally {
    await browser?.close();
    await Promise.all([close(fixture.server), close(alternate.server)]);
  }
});
