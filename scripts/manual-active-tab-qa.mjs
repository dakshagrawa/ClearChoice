/* global window, location, document */
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { LOCAL_HUMAN_ATTESTATION, sha256 } from './active-tab-qa.mjs';

const root = resolve(import.meta.dirname, '..');
const extensionPath = resolve(root, 'dist');
const fixturePaths = {
  clean: resolve(root, 'fixtures/clean-checkout.html'),
  dynamic: resolve(root, 'fixtures/beta-dynamic-checkout.html'),
};
const fixtureOriginPattern = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

export function fixtureForRequest(url) {
  if (url === '/checkout/clean') return 'clean';
  if (url === '/checkout/dynamic-beta') return 'dynamic';
  throw new Error('unknown manual QA fixture request');
}

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

async function captureIntegrityBaseline(page) {
  await page.evaluate(() => {
    const owned = (node) => node.closest('[data-clearchoice-panel]') !== null;
    window.__clearchoiceManualIntegrityBaseline = {
      href: location.href,
      forms: Array.from(document.forms, (form) => form.action),
      controls: Array.from(document.querySelectorAll('input, select'))
        .filter((node) => !owned(node))
        .map((node) => [node.tagName, node.name, node.type, node.value, node.checked, node.disabled]),
      nodes: Array.from(document.querySelectorAll('input, button, a')).filter((node) => !owned(node)),
    };
  });
}

async function integrityPassed(page) {
  return page.evaluate(() => {
    const baseline = window.__clearchoiceManualIntegrityBaseline;
    if (!baseline) return false;
    const owned = (node) => node.closest('[data-clearchoice-panel]') !== null;
    const controls = Array.from(document.querySelectorAll('input, select'))
      .filter((node) => !owned(node))
      .map((node) => [node.tagName, node.name, node.type, node.value, node.checked, node.disabled]);
    const nodes = Array.from(document.querySelectorAll('input, button, a')).filter((node) => !owned(node));
    return location.href === baseline.href
      && JSON.stringify(Array.from(document.forms, (form) => form.action)) === JSON.stringify(baseline.forms)
      && JSON.stringify(controls) === JSON.stringify(baseline.controls)
      && nodes.length === baseline.nodes.length
      && nodes.every((node, index) => node === baseline.nodes[index]);
  });
}

async function assertIntegrity(page, phase) {
  if (!(await integrityPassed(page))) throw new Error(`manual ${phase} integrity predicate failed`);
}

async function waitForPanel(page, state) {
  await page.locator('aside[data-clearchoice-panel]').waitFor({ state, timeout: 300_000 });
}

export async function runManualActiveTabQa(argv = process.argv.slice(2)) {
  parseArguments(argv);
  await readFile(resolve(extensionPath, 'manifest.json'));
  const fixtures = Object.fromEntries(await Promise.all(
    Object.entries(fixturePaths).map(async ([name, path]) => [name, await readFile(path)]),
  ));
  const server = createServer((request, response) => {
    try {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixtures[fixtureForRequest(request.url)]);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
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
    const cleanPage = await context.newPage();
    await cleanPage.goto(`${fixtureOrigin}/checkout/clean`);
    await captureIntegrityBaseline(cleanPage);
    await cleanPage.bringToFront();

    process.stdout.write('\nManual active-tab QA is waiting. In the runner-provided visible Chromium window:\n');
    process.stdout.write('That Chromium can access only the local 127.0.0.1 fixtures and the extension; its dead proxy blocks non-loopback sites, so it cannot validate real sites. This boundary applies only to Chromium launched by this runner, not other browser instances.\n');
    process.stdout.write('CLEAN FIXTURE: click the ClearChoice toolbar icon with the pointer, then click Analyze in the browser-owned popup with the pointer.\n');
    process.stdout.write('The runner captures only panel/integrity pass-fail predicates and never writes or prints page data.\n\n');

    await waitForPanel(cleanPage, 'attached');
    await assertIntegrity(cleanPage, 'clean-fixture Analyze');

    const dynamicPage = await context.newPage();
    await dynamicPage.goto(`${fixtureOrigin}/checkout/dynamic-beta#checkout`);
    await captureIntegrityBaseline(dynamicPage);
    await dynamicPage.bringToFront();
    process.stdout.write('DYNAMIC FIXTURE: click the toolbar icon with the pointer, then click Analyze in its popup with the pointer.\n');
    await waitForPanel(dynamicPage, 'attached');
    await assertIntegrity(dynamicPage, 'dynamic-fixture Analyze');

    process.stdout.write('DYNAMIC FIXTURE: dismiss the findings panel with its pointer control.\n');
    await waitForPanel(dynamicPage, 'detached');
    await assertIntegrity(dynamicPage, 'dynamic-fixture Dismiss');

    process.stdout.write('DYNAMIC FIXTURE: use a toolbar pointer click and popup pointer click to Restore, then repeat toolbar/popup pointer Analyze twice. Click Replace fake order summary with the pointer.\n');
    process.stdout.write('After those steps, return to this terminal and type ATTEST only if you personally observed all pointer actions complete.\n');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const attestation = await terminal.question('Type ATTEST to evaluate final pass/fail predicates and emit the marker: ');
    terminal.close();
    if (attestation !== 'ATTEST') throw new Error('manual human attestation was not confirmed; marker was not emitted');

    await waitForPanel(dynamicPage, 'attached');
    if (await dynamicPage.locator('aside[data-clearchoice-panel]').count() !== 1) throw new Error('manual dynamic-fixture repeated Analyze panel predicate failed');
    await dynamicPage.locator('#fake-order-summary').waitFor({ state: 'attached', timeout: 300_000 });
    const replacementPassed = await dynamicPage.locator('#fake-order-summary').evaluate((summary) => summary.textContent?.includes('updated') === true);
    if (!replacementPassed) throw new Error('manual dynamic-fixture replacement predicate failed');
    await assertIntegrity(dynamicPage, 'dynamic-fixture Restore/repeated Analyze/replacement');

    const marker = {
      schemaVersion: 2,
      outcome: 'passed',
      cleanFixtureIntegrity: 'passed',
      dynamicFixtureIntegrity: 'passed',
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
