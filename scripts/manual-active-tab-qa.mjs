import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { sha256 } from './active-tab-qa.mjs';

const root = resolve(import.meta.dirname, '..');
const extensionPath = resolve(root, 'dist');
const fixturePath = resolve(root, 'fixtures/clean-checkout.html');

function usage() {
  throw new Error('usage: node scripts/manual-active-tab-qa.mjs --marker PATH --reviewer NAME');
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--marker' || argv[2] !== '--reviewer' || !argv[1] || !argv[3].trim()) usage();
  return { markerPath: resolve(argv[1]), reviewer: argv[3].trim() };
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

const { markerPath, reviewer } = parseArguments(process.argv.slice(2));
const fixture = await readFile(fixturePath);
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
});
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('fixture server did not expose a TCP port');

const profile = await mkdtemp(resolve(tmpdir(), 'clearchoice-manual-active-tab-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const fixturePage = await context.newPage();
  await fixturePage.goto(`http://127.0.0.1:${address.port}/checkout/clean`);
  await fixturePage.bringToFront();

  process.stdout.write('\nManual active-tab QA is waiting. In the visible Chromium window:\n');
  process.stdout.write('1. Click the ClearChoice toolbar icon (do not use a keyboard shortcut).\n');
  process.stdout.write('2. In that browser-owned popup, click Analyze with the pointer.\n');
  process.stdout.write('The script observes only whether the local fixture receives a ClearChoice panel; it reads no page data.\n\n');

  await fixturePage.locator('aside[data-clearchoice-panel]').waitFor({ state: 'attached', timeout: 300_000 });
  const marker = {
    schemaVersion: 1,
    outcome: 'passed',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    manifestSha256: sha256(await readFile(resolve(root, 'manifest.json'))),
    reviewer,
  };
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write('manual active-tab QA passed; wrote pass-only marker without page data\n');
} catch (error) {
  process.stderr.write(`manual active-tab QA failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await context?.close();
  await closeServer(server);
  await rm(profile, { recursive: true, force: true });
}
