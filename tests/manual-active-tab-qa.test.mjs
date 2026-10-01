// @vitest-environment node
/* global window */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createFixtureTls } from '../scripts/manual-qa-fixtures.mjs';
import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, expect, test, vi } from 'vitest';
import { observeCleanState } from '../scripts/manual-qa-stages.mjs';
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
  runSiteCheckpoints,
  runCleanupSteps,
  recheckCandidateBinding,
  reviewCandidate,
  serveFixture,
} from '../scripts/manual-active-tab-qa.mjs';

const root = resolve(process.cwd());
const temporaryPaths = [];

// Same real build-manifest/ZIP builder as exact-archive-gate, with no human marker.
async function archiveFixture(run) {
  const dir = mkdtempSync(resolve(process.env.TMPDIR ?? '/home/daksh/.hermes/cache/scratch', 'manual-recheck-'));
  const repo = resolve(dir, 'repo');
  mkdirSync(repo);
  cpSync(resolve('scripts'), resolve(repo, 'scripts'), { recursive: true });
  for (const name of ['manifest.json', 'package.json']) cpSync(resolve(name), resolve(repo, name));
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: repo });
  const assets = resolve(dir, 'assets');
  mkdirSync(resolve(assets, 'popup'), { recursive: true });
  execFileSync(process.execPath, ['scripts/build-manifest.mjs', '--release', '--output', resolve(assets, 'manifest.json')], { cwd: repo });
  writeFileSync(resolve(assets, 'content.js'), 'void 0;');
  writeFileSync(resolve(assets, 'worker.js'), 'void 0;');
  writeFileSync(resolve(assets, 'popup/index.html'), '<html>fixture</html>');
  const archive = artifacts.unpackedArchivePath(repo);
  execFileSync('zip', ['-qr', archive, '.'], { cwd: assets });
  const initial = artifacts.prepareCandidateArchive(repo);
  try { await run({ repo, archive, assets, initial }); }
  finally { initial.cleanup(); rmSync(dir, { recursive: true, force: true }); }
}

test('clean baseline observes a real extension worker using read-only browser APIs', () => archiveFixture(async ({ initial }) => {
  const profile = await mkdtemp(resolve(tmpdir(), 'manual-readback-profile-'));
  temporaryPaths.push(profile);
  const browser = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, args: restrictedBrowserArgs(initial.extensionPath),
  });
  try {
    const page = await browser.newPage();
    await page.bringToFront();
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
    const summary = await worker.evaluate(`(${observeCleanState.toString()})(chrome, 'capture', 'https://checkout-a.test:123/checkout/clean')`);
    expect(summary).toEqual({ storageValid: true, historyCount: 0, subscriptionCount: 0, unchanged: true, permissionCount: 0, scriptCount: 0, grantCount: 0, badgeBlank: true });
  } finally { await browser.close(); }
}));

test('final binding accepts unchanged exact ZIP without rebuilding or deleting review extraction', () => archiveFixture(async ({ repo, archive, initial }) => {
  const before = readFileSync(archive);
  await expect(recheckCandidateBinding(repo, initial)).resolves.toBe(true);
  expect(readFileSync(archive)).toEqual(before);
  expect(readFileSync(resolve(initial.extensionPath, 'content.js'), 'utf8')).toBe('void 0;');
}));

test('final binding vetoes mutated complete ZIP and dirty or changed source', async () => {
  for (const mutation of ['zip', 'dirty', 'commit']) await archiveFixture(async ({ repo, archive, assets, initial }) => {
    if (mutation === 'zip') {
      writeFileSync(resolve(assets, 'content.js'), 'void 1;');
      execFileSync('zip', ['-qr', archive, '.'], { cwd: assets });
    } else {
      writeFileSync(resolve(repo, 'manifest.json'), readFileSync(resolve(repo, 'manifest.json'), 'utf8') + '\n');
      if (mutation === 'commit') {
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'change'], { cwd: repo });
      }
    }
    await expect(recheckCandidateBinding(repo, initial)).rejects.toThrow(mutation === 'dirty' ? 'dirty tracked' : 'candidate changed');
    expect(readFileSync(resolve(initial.extensionPath, 'content.js'), 'utf8')).toBe('void 0;');
  });
});

function listen(host, port, body, tls) {
  let requests = 0;
  const handler = (_request, response) => {
    requests += 1;
    response.end(body);
  };
  const server = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, handler) : createServer(handler);
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

test('clean zero never waits for an empty panel and gates the next page on acknowledgement and readback', async () => {
  const events = [];
  let release;
  const quiet = new Promise((resolve) => { release = resolve; });
  const wait = vi.fn();
  const run = runManualCheckpoints({
    cleanPage: 'clean', getDynamicPage: () => 'dynamic',
    instruct: (text) => events.push(text),
    confirmCleanAnalyze: async () => { events.push('clean:ack'); },
    assertCleanQuiet: async () => { events.push('clean:readback'); await quiet; },
    waitForPanel: wait, assertIntegrity: async () => {}, confirmRestore: async () => {},
    openDynamic: async () => { events.push('open:dynamic'); },
    waitForReplacement: async () => {}, confirmRepeatedAnalyze: async () => {},
  });
  await vi.waitFor(() => expect(events).toContain('clean:readback'));
  expect(wait).not.toHaveBeenCalled();
  expect(events).not.toContain('open:dynamic');
  release();
  await run;
  expect(events.indexOf('clean:ack')).toBeLessThan(events.indexOf('open:dynamic'));
  expect(wait.mock.calls.every(([page]) => page === 'dynamic')).toBe(true);
});

test('site workflow cannot treat quiet state as denial or advance before acknowledgement', async () => {
  const events = [];
  let denialObserved = false;
  const options = {
    instruct: () => {}, acknowledge: async () => { events.push('ack'); return 'DONE'; },
    navigate: async (site, positive) => events.push(`visit:${site}:${positive}`),
    read: async (mode, site) => { events.push(`${mode}:${site}`); return true; },
    quiet: async () => true, positive: async () => true,
    denied: async () => denialObserved,
    integrity: async () => {}, mutate: async () => {},
  };
  await expect(runSiteCheckpoints(options)).rejects.toThrow('observable');
  expect(events).not.toContain('before-revoke:a');
  expect(events.filter((event) => event === 'ack')).toHaveLength(2);
  denialObserved = true;
  events.length = 0;
  await runSiteCheckpoints(options);
  expect(events.indexOf('quiet:b')).toBeLessThan(events.indexOf('before-revoke:a'));
  expect(events.filter((event) => event === 'revoked:a')).toHaveLength(3);
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
    expect(launch.mock.calls[0][1].args).toContain(`--load-extension=${extensionPath}`);
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    launch.mockRestore();
    prepared.mockRestore();
  }
});

test('runner preserves launch failure when candidate cleanup also fails', async () => {
  const failure = new Error('launch primary');
  const cleanup = vi.fn(() => { throw new Error('candidate cleanup'); });
  const prepared = vi.spyOn(artifacts, 'prepareCandidateArchive').mockReturnValue({ extensionPath: root, cleanup });
  const launch = vi.spyOn(chromium, 'launchPersistentContext').mockRejectedValue(failure);
  try {
    await expect(runManualActiveTabQa([])).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledOnce();
  } finally { prepared.mockRestore(); launch.mockRestore(); }
});

test('TLS acquisition failure is preserved without creating later resources', async () => {
  const primary = new Error('TLS setup');
  const makeServer = vi.fn();
  await expect(reviewCandidate({ extensionPath: root }, {
    createTls: async () => { throw primary; }, makeServer,
  })).rejects.toBe(primary);
  expect(makeServer).not.toHaveBeenCalled();
});

test('listen setup failure attempts server and TLS cleanup exactly once without masking primary', async () => {
  const primary = new Error('listen setup');
  const tls = { cleanup: vi.fn(() => { throw new Error('TLS cleanup'); }) };
  let fail;
  const server = {
    once: vi.fn((_event, callback) => { fail = callback; }),
    listen: vi.fn(() => fail(primary)),
    close: vi.fn((callback) => callback(new Error('server close'))),
  };
  await expect(reviewCandidate({ extensionPath: root }, {
    createTls: async () => tls, makeServer: () => server,
  })).rejects.toBe(primary);
  expect(server.close).toHaveBeenCalledOnce();
  expect(tls.cleanup).toHaveBeenCalledOnce();
});

test('midworkflow error survives browser close failure and every remaining resource closes once', async () => {
  const primary = new Error('navigation primary');
  const tls = { cleanup: vi.fn() };
  const server = {
    once: vi.fn(), listen: vi.fn((_port, _host, callback) => callback()),
    address: () => ({ address: '127.0.0.1', port: 12345 }),
    close: vi.fn((callback) => callback()),
  };
  const browser = { newPage: async () => ({ goto: async () => { throw primary; } }), close: vi.fn(async () => { throw new Error('browser close'); }) };
  const removeProfile = vi.fn();
  await expect(reviewCandidate({ extensionPath: root }, {
    createTls: async () => tls, makeServer: () => server,
    createProfile: async () => 'unit-profile', launchContext: async () => browser, removeProfile,
  })).rejects.toBe(primary);
  for (const closer of [browser.close, server.close, removeProfile, tls.cleanup]) expect(closer).toHaveBeenCalledOnce();
});

test('runner surfaces candidate cleanup-only failure without a human QA result', async () => {
  const failure = new Error('candidate cleanup only');
  const cleanup = vi.fn(() => { throw failure; });
  await expect(runManualActiveTabQa([], {
    prepare: () => ({ cleanup }), review: async () => undefined,
  })).rejects.toBe(failure);
  expect(cleanup).toHaveBeenCalledOnce();
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
  expect(fixtureOriginForServerAddress({ address: '127.0.0.1', port: 43123 })).toBe('https://checkout-a.test:43123');
  expect(() => fixtureOriginForServerAddress({ address: '127.0.0.2', port: 43123 })).toThrow('fixture server must bind exactly to 127.0.0.1');
  expect(() => fixtureOriginForServerAddress({ address: '127.0.0.1', port: 0 })).toThrow('fixture server did not expose a valid TCP port');
});

test('restricts review Chromium to only its 127.0.0.1 fixture and disables implicit loopback bypass', () => {
  const extensionPath = resolve(root, 'dist');
  expect(restrictedBrowserArgs(extensionPath)).toEqual([
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>;checkout-a.test;checkout-b.test',
    '--host-resolver-rules=MAP checkout-a.test 127.0.0.1, MAP checkout-b.test 127.0.0.1, MAP * ~NOTFOUND',
    '--disable-quic',
  ]);
  expect(reviewBrowserLaunchOptions(extensionPath)).toEqual({
    channel: 'chromium',
    headless: false,
    args: restrictedBrowserArgs(extensionPath),
  });
  expect(() => assertFixtureOrigin('https://checkout-a.test:43123')).not.toThrow();
  for (const origin of ['http://localhost:43123', 'http://127.0.0.2:43123', 'https://127.0.0.1:43123', 'http://127.0.0.1:0']) {
    expect(() => assertFixtureOrigin(origin)).toThrow('fixture origin must be exactly https://checkout-a.test:<port>');
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

    expect(() => createManualActiveTabQaMarker({ commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), archiveSha256: 'c'.repeat(64) })).toThrow('workflow results');
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

test('Chromium reaches the pinned HTTPS fixture but cannot reach 127.0.0.2 or a non-loopback address', async () => {
  const tls = await createFixtureTls();
  const fixture = await listen('127.0.0.1', 0, 'fixture', tls);
  const alternate = await listen('127.0.0.2', fixture.server.address().port, 'alternate');
  const profile = await mkdtemp(resolve(tmpdir(), 'clearchoice-proxy-boundary-'));
  temporaryPaths.push(profile);
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: reviewBrowserLaunchOptions(resolve(root, 'dist'), tls.pin).args,
    });
    const page = await browser.newPage();
    await expect(page.goto(`https://checkout-a.test:${fixture.server.address().port}`, { timeout: 5_000 })).resolves.toBeTruthy();
    await expect(page.goto(alternate.origin, { timeout: 5_000 })).rejects.toThrow();
    await expect(page.goto('http://198.51.100.1:8080/', { timeout: 5_000 })).rejects.toThrow();
    expect(fixture.requests).toBeGreaterThan(0);
    expect(alternate.requests).toBe(0);
  } finally {
    await browser?.close();
    await runCleanupSteps([() => close(fixture.server), () => close(alternate.server), () => tls.cleanup()]);
  }
});
