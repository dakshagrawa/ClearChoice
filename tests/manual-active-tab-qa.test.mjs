// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { assertFixtureOrigin, restrictedBrowserArgs, reviewBrowserLaunchOptions } from '../scripts/manual-active-tab-qa.mjs';

const root = resolve(process.cwd());
const temporaryPaths = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('restricts the review Chromium to an exact IPv4 loopback fixture and a dead proxy boundary', () => {
  const extensionPath = resolve(root, 'dist');
  expect(restrictedBrowserArgs(extensionPath)).toEqual([
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=127.0.0.1',
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

test('runner rejects a configured non-loopback fixture origin before starting review Chromium', async () => {
  const markerDirectory = await mkdtemp(resolve(tmpdir(), 'clearchoice-manual-active-tab-test-'));
  temporaryPaths.push(markerDirectory);
  const result = spawnSync(process.execPath, ['scripts/manual-active-tab-qa.mjs', '--marker', resolve(markerDirectory, 'marker.json'), '--reviewer', 'test'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLEARCHOICE_MANUAL_FIXTURE_ORIGIN: 'https://example.test:443' },
    timeout: 5_000,
  });

  expect(result.signal).toBeNull();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('fixture origin must be exactly http://127.0.0.1:<port>');
  expect(result.stderr).not.toContain('Manual active-tab QA is waiting');
});
