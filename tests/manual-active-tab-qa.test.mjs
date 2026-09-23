// @vitest-environment node
import { createServer } from 'node:http';
import { lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, expect, test } from 'vitest';
import {
  assertFixtureOrigin,
  fixtureOriginForServerAddress,
  restrictedBrowserArgs,
  reviewBrowserLaunchOptions,
  runManualActiveTabQa,
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

test('manual runner rejects an external marker symlink into the repository before writing its target', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-marker-symlink-'));
  temporaryPaths.push(markerDirectory);
  const target = resolve(root, 'fixtures/clean-checkout.html');
  const before = await readFile(target);
  const markerPath = resolve(markerDirectory, 'manual-active-tab-qa.json');
  await symlink(target, markerPath);

  await expect(runManualActiveTabQa(['--marker', markerPath])).rejects.toThrow('marker path must resolve outside the repository');
  expect(await readFile(target)).toEqual(before);
  expect((await lstat(markerPath)).isSymbolicLink()).toBe(true);
});

test('manual runner rejects a dangling marker symlink without creating its repository target', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-dangling-marker-'));
  temporaryPaths.push(markerDirectory);
  const target = resolve(root, '.manual-active-tab-qa-dangling-target.json');
  const markerPath = resolve(markerDirectory, 'manual-active-tab-qa.json');
  await symlink(target, markerPath);

  await expect(runManualActiveTabQa(['--marker', markerPath])).rejects.toThrow('marker destination must not be a symlink');
  await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
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
