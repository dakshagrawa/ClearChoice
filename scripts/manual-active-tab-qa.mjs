import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { sha256 } from './active-tab-qa.mjs';

const root = resolve(import.meta.dirname, '..');
const extensionPath = resolve(root, 'dist');
const fixturePath = resolve(root, 'fixtures/clean-checkout.html');
const fixtureOriginPattern = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

export function assertFixtureOrigin(origin) {
  const match = fixtureOriginPattern.exec(origin);
  if (!match || Number(match[1]) > 65_535) {
    throw new Error('fixture origin must be exactly http://127.0.0.1:<port>');
  }
  return origin;
}

export function restrictedBrowserArgs(extensionDirectory) {
  return [
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=127.0.0.1',
    '--disable-quic',
  ];
}

export function reviewBrowserLaunchOptions(extensionDirectory) {
  return {
    channel: 'chromium',
    headless: false,
    args: restrictedBrowserArgs(extensionDirectory),
  };
}

function usage() {
  throw new Error('usage: node scripts/manual-active-tab-qa.mjs --marker PATH --reviewer NAME');
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--marker' || argv[2] !== '--reviewer' || !argv[1] || !argv[3].trim()) usage();
  const markerPath = resolve(argv[1]);
  const pathFromRoot = relative(root, markerPath);
  if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !pathFromRoot.startsWith('/'))) {
    throw new Error('marker path must be outside the repository so it cannot be committed or archived');
  }
  return { markerPath, reviewer: argv[3].trim() };
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

export async function runManualActiveTabQa(argv = process.argv.slice(2), environment = process.env) {
  const { markerPath: requestedMarkerPath, reviewer } = parseArguments(argv);
  await mkdir(dirname(requestedMarkerPath), { recursive: true, mode: 0o700 });
  const markerPath = resolve(await realpath(dirname(requestedMarkerPath)), basename(requestedMarkerPath));
  const canonicalPathFromRoot = relative(root, markerPath);
  if (canonicalPathFromRoot === '' || (!canonicalPathFromRoot.startsWith('..') && !canonicalPathFromRoot.startsWith('/'))) {
    throw new Error('marker path must resolve outside the repository so it cannot be committed or archived');
  }
  await readFile(resolve(extensionPath, 'manifest.json'));
  const fixture = await readFile(fixturePath);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  let profile;
  let context;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not expose a TCP port');
    const fixtureOrigin = assertFixtureOrigin(environment.CLEARCHOICE_MANUAL_FIXTURE_ORIGIN ?? `http://127.0.0.1:${address.port}`);

    profile = await mkdtemp(resolve(tmpdir(), 'clearchoice-manual-active-tab-'));
    context = await chromium.launchPersistentContext(profile, reviewBrowserLaunchOptions(extensionPath));
    const fixturePage = await context.newPage();
    await fixturePage.goto(`${fixtureOrigin}/checkout/clean`);
    await fixturePage.bringToFront();

    process.stdout.write('\nManual active-tab QA is waiting. In the runner-provided visible Chromium window:\n');
    process.stdout.write('That Chromium can access only the local 127.0.0.1 fixture and the extension; its dead proxy blocks non-loopback sites, so it cannot validate real sites. This boundary applies only to Chromium launched by this runner, not other browser instances.\n');
    process.stdout.write('1. Click the ClearChoice toolbar icon with the pointer (do not use a keyboard shortcut).\n');
    process.stdout.write('2. In that browser-owned popup, click Analyze with the pointer.\n');
    process.stdout.write('The script observes only whether the local fixture receives a ClearChoice panel; it reads no page data.\n\n');

    await fixturePage.locator('aside[data-clearchoice-panel]').waitFor({ state: 'attached', timeout: 300_000 });
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const attestation = await terminal.question('After personally completing both pointer clicks, type ATTEST to write the pass-only marker: ');
    terminal.close();
    if (attestation !== 'ATTEST') throw new Error('manual human attestation was not confirmed; marker was not written');
    const marker = {
      schemaVersion: 1,
      outcome: 'passed',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      manifestSha256: sha256(await readFile(resolve(root, 'manifest.json'))),
      reviewer,
    };
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write('manual active-tab QA passed; wrote pass-only marker without page data\n');
  } finally {
    await context?.close();
    await closeServer(server);
    if (profile) await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runManualActiveTabQa();
  } catch (error) {
    process.stderr.write(`manual active-tab QA failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
