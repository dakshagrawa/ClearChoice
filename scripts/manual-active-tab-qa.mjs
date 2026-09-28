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

export function serveFixture(url, response, fixtures) {
  let fixture;
  try {
    fixture = fixtures[fixtureForRequest(url)];
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fixture);
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

async function integrityDigest(page) {
  const snapshot = await page.evaluate(() => {
    const owned = (node) => node.closest('[data-clearchoice-panel]') !== null;
    return JSON.stringify({
      href: location.href,
      forms: Array.from(document.forms, (form) => form.action),
      controls: Array.from(document.querySelectorAll('input, select'))
        .filter((node) => !owned(node))
        .map((node) => [node.tagName, node.name, node.type, node.value, node.checked, node.disabled]),
      hostNodes: Array.from(document.querySelectorAll('input, button, a'))
        .filter((node) => !owned(node))
        .map((node) => node.outerHTML),
    });
  });
  return sha256(snapshot);
}

export async function captureIntegrityBaseline(page) {
  const digest = await integrityDigest(page);
  await page.evaluate((value) => {
    window.__clearchoiceManualIntegrityBaseline = {
      digest: value,
      predicates: { integrity: true },
    };
  }, digest);
}

export async function integrityPassed(page) {
  const digest = await integrityDigest(page);
  return page.evaluate((value) => {
    const baseline = window.__clearchoiceManualIntegrityBaseline;
    if (!baseline) return false;
    const passed = value === baseline.digest;
    baseline.predicates.integrity &&= passed;
    return passed;
  }, digest);
}

async function assertIntegrity(page, phase) {
  if (!(await integrityPassed(page))) throw new Error(`manual ${phase} integrity predicate failed`);
}

async function waitForPanel(page, state) {
  await page.locator('aside[data-clearchoice-panel]').waitFor({ state, timeout: 300_000 });
}

// Gesture checkpoints are human-operated: this function never clicks the browser UI.
export async function runManualCheckpoints({ cleanPage, getDynamicPage, instruct, waitForPanel: wait, assertIntegrity: check, confirmRestore, openDynamic, waitForReplacement, confirmRepeatedAnalyze }) {
  instruct('1. CLEAN: pointer-click the toolbar icon, then pointer-click Analyze in its popup.');
  await wait(cleanPage, 'attached');
  await check(cleanPage, 'clean-fixture Analyze');
  instruct('2. CLEAN: press Tab until Dismiss visibly has focus, then press Escape. Confirm only the panel closes.');
  await wait(cleanPage, 'detached');
  await check(cleanPage, 'clean-fixture Escape');
  instruct('3. CLEAN: pointer-click the toolbar icon, then pointer-click Restore in its popup. Confirm in the terminal only after doing both.');
  await confirmRestore(cleanPage);
  await check(cleanPage, 'clean-fixture Restore');

  await openDynamic();
  const dynamicPage = getDynamicPage();
  instruct('4. DYNAMIC: pointer-click the toolbar icon, then pointer-click Analyze in its popup.');
  await wait(dynamicPage, 'attached');
  await check(dynamicPage, 'dynamic-fixture Analyze');
  instruct('5. DYNAMIC: press Tab until Dismiss visibly has focus, then press Escape. Confirm only the panel closes.');
  await wait(dynamicPage, 'detached');
  await check(dynamicPage, 'dynamic-fixture Escape');
  instruct('6. DYNAMIC: pointer-click the toolbar icon, then pointer-click Restore in its popup. Confirm in the terminal only after doing both.');
  await confirmRestore(dynamicPage);
  await check(dynamicPage, 'dynamic-fixture Restore after Escape');
  instruct('7. DYNAMIC: pointer-click the toolbar icon, then pointer-click Analyze in its popup to reopen the panel.');
  await wait(dynamicPage, 'attached');
  await check(dynamicPage, 'dynamic-fixture reopened Analyze');
  instruct('8. DYNAMIC: pointer-click Dismiss on the visible findings panel.');
  await wait(dynamicPage, 'detached');
  await check(dynamicPage, 'dynamic-fixture Dismiss');
  instruct('9. DYNAMIC: pointer-click the toolbar icon, then pointer-click Restore in its popup. Confirm in the terminal only after doing both.');
  await confirmRestore(dynamicPage);
  await check(dynamicPage, 'dynamic-fixture Restore after Dismiss');
  instruct('10. DYNAMIC: pointer-click the toolbar icon, then pointer-click Analyze in its popup.');
  await wait(dynamicPage, 'attached');
  await check(dynamicPage, 'dynamic-fixture repeated Analyze');
  instruct('11. DYNAMIC: pointer-click the toolbar icon and popup Analyze once more. Confirm in the terminal only after doing both.');
  await confirmRepeatedAnalyze();
  await check(dynamicPage, 'dynamic-fixture second repeated Analyze');
  instruct('12. DYNAMIC: pointer-click Replace fake order summary.');
  await waitForReplacement();
  await check(dynamicPage, 'dynamic-fixture Restore/repeated Analyze/replacement');
}

export function createManualActiveTabQaMarker({ commit, manifestSha256 }) {
  return {
    schemaVersion: 2,
    outcome: 'passed',
    cleanFixtureIntegrity: 'passed',
    dynamicFixtureIntegrity: 'passed',
    accessibility: true,
    commit,
    manifestSha256,
    reviewer: LOCAL_HUMAN_ATTESTATION,
  };
}

export async function runManualActiveTabQa(argv = process.argv.slice(2)) {
  parseArguments(argv);
  await readFile(resolve(extensionPath, 'manifest.json'));
  const fixtures = Object.fromEntries(await Promise.all(
    Object.entries(fixturePaths).map(async ([name, path]) => [name, await readFile(path)]),
  ));
  const server = createServer((request, response) => {
    serveFixture(request.url, response, fixtures);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  let profile;
  let context;
  let terminal;
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
    process.stdout.write('The runner retains only SHA-256 integrity digests and panel/integrity pass-fail predicates; it never writes or prints page data.\n\n');
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    let dynamicPage;
    await runManualCheckpoints({
      cleanPage,
      getDynamicPage: () => dynamicPage,
      instruct: (text) => process.stdout.write(`${text}\n`),
      waitForPanel,
      assertIntegrity,
      confirmRestore: async () => {
        if (await terminal.question('Type RESTORED after both pointer clicks (anything else aborts): ') !== 'RESTORED') {
          throw new Error('manual pointer Restore was not confirmed; marker was not emitted');
        }
      },
      openDynamic: async () => {
        dynamicPage = await context.newPage();
        await dynamicPage.goto(`${fixtureOrigin}/checkout/dynamic-beta#checkout`);
        await captureIntegrityBaseline(dynamicPage);
        await dynamicPage.bringToFront();
      },
      confirmRepeatedAnalyze: async () => {
        if (await terminal.question('Type ANALYZED after both pointer clicks (anything else aborts): ') !== 'ANALYZED') {
          throw new Error('manual repeated Analyze was not confirmed; marker was not emitted');
        }
        if (await dynamicPage.locator('aside[data-clearchoice-panel]').count() !== 1) {
          throw new Error('manual dynamic-fixture repeated Analyze panel predicate failed');
        }
      },
      waitForReplacement: async () => {
        await dynamicPage.locator('#fake-order-summary').waitFor({ state: 'attached', timeout: 300_000 });
        await dynamicPage.waitForFunction(() => document.querySelector('#fake-order-summary')?.textContent?.includes('updated') === true, undefined, { timeout: 300_000 });
      },
    });
    process.stdout.write('After those steps, return to this terminal and type ATTEST only if you personally observed all pointer actions complete.\n');
    const attestation = await terminal.question('Type ATTEST to evaluate final pass/fail predicates and emit the marker: ');
    if (attestation !== 'ATTEST') throw new Error('manual human attestation was not confirmed; marker was not emitted');

    const marker = createManualActiveTabQaMarker({
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      manifestSha256: sha256(await readFile(resolve(root, 'manifest.json'))),
    });
    process.stdout.write('manual active-tab QA passed; save this local self-attestation outside the repository (for example ~/.local/state/clearchoice/active-tab-qa.json), then pass that path through CLEARCHOICE_ACTIVE_TAB_QA_MARKER:\n');
    process.stdout.write(`${JSON.stringify(marker, null, 2)}\n`);
  } finally {
    terminal?.close();
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
