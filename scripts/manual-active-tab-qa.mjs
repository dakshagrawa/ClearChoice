import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { LOCAL_HUMAN_ATTESTATION, sha256 } from './active-tab-qa.mjs';

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

export function fixtureOriginForServerAddress(address) {
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    throw new Error('fixture server must bind exactly to 127.0.0.1');
  }
  if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) {
    throw new Error('fixture server did not expose a valid TCP port');
  }
  return assertFixtureOrigin(`http://127.0.0.1:${address.port}`);
}

export function restrictedBrowserArgs(extensionDirectory) {
  return [
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>;127.0.0.1',
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
  throw new Error('usage: node scripts/manual-active-tab-qa.mjs');
}

function parseArguments(argv) {
  if (argv.length !== 0) usage();
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

export async function runManualActiveTabQa(argv = process.argv.slice(2)) {
  parseArguments(argv);
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
    const fixtureOrigin = fixtureOriginForServerAddress(address);

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
    const attestation = await terminal.question('After personally completing both pointer clicks, type ATTEST to emit the pass-only marker: ');
    terminal.close();
    if (attestation !== 'ATTEST') throw new Error('manual human attestation was not confirmed; marker was not emitted');
    const marker = {
      schemaVersion: 1,
      outcome: 'passed',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      manifestSha256: sha256(await readFile(resolve(root, 'manifest.json'))),
      reviewer: LOCAL_HUMAN_ATTESTATION,
    };
    process.stdout.write('manual active-tab QA passed; save this local self-attestation outside the repository (for example ~/.local/state/clearchoice/active-tab-qa.json), then pass that path through CLEARCHOICE_ACTIVE_TAB_QA_MARKER:\n');
    process.stdout.write(`${JSON.stringify(marker, null, 2)}\n`);
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
