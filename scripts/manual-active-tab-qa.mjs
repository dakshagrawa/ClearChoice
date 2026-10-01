/* global window, location, document */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createFixtureTls, mockCheckoutHtml } from './manual-qa-fixtures.mjs';
import { LOCAL_HUMAN_ATTESTATION, WORKFLOW_PREDICATES, validateManualActiveTabMarker, sha256 } from './active-tab-qa.mjs';
import { observeCleanState, runWithCleanup } from './manual-qa-stages.mjs';
import { prepareCandidateArchive } from './release-artifact.mjs';

const root = resolve(import.meta.dirname, '..');

const fixtureOriginPattern = /^https:\/\/checkout-a\.test:([1-9]\d{0,4})$/;

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
    throw new Error('fixture origin must be exactly https://checkout-a.test:<port>');
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
  return assertFixtureOrigin(`https://checkout-a.test:${address.port}`);
}

export function restrictedBrowserArgs(extensionDirectory) {
  return [
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>;checkout-a.test;checkout-b.test',
    '--host-resolver-rules=MAP checkout-a.test 127.0.0.1, MAP checkout-b.test 127.0.0.1, MAP * ~NOTFOUND',
    '--disable-quic',
  ];
}

export function reviewBrowserLaunchOptions(extensionDirectory, pin) {
  return {
    channel: 'chromium',
    headless: false,
    args: [...restrictedBrowserArgs(extensionDirectory), ...(pin ? [`--ignore-certificate-errors-spki-list=${pin}`] : [])],
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

export async function runCleanupSteps(steps) {
  await runWithCleanup(async () => {}, steps);
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
export async function runManualCheckpoints({ cleanPage, getDynamicPage, instruct, waitForPanel: wait, assertIntegrity: check, confirmRestore, openDynamic, waitForReplacement, confirmRepeatedAnalyze, confirmCleanAnalyze, assertCleanQuiet }) {
  instruct('1. CLEAN: pointer-click the toolbar icon, then pointer-click Analyze in its popup.');
  await confirmCleanAnalyze(cleanPage);
  await assertCleanQuiet(cleanPage);
  await check(cleanPage, 'clean-fixture Analyze');

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

export function createManualActiveTabQaMarker({ commit, manifestSha256, archiveSha256 }, results) {
  if (!results || Object.getPrototypeOf(results) !== Object.prototype
      || Reflect.ownKeys(results).length !== WORKFLOW_PREDICATES.length
      || WORKFLOW_PREDICATES.some((field) => !Object.hasOwn(results, field))) {
    throw new Error('complete validated workflow results are required; marker was not emitted');
  }
  const marker = { schemaVersion: 4, outcome: 'passed', ...results,
    commit, manifestSha256, archiveSha256, reviewer: LOCAL_HUMAN_ATTESTATION };
  const validation = validateManualActiveTabMarker(marker, { commit, manifestSha256, archiveSha256 });
  if (!validation.ok) throw new Error(validation.error);
  return marker;
}

// Mandatory immediately before any future marker emission, after ALL human stages.
// Revalidate the current complete ZIP and clean source via the same reviewed API;
// never rebuild and never substitute this verification extraction for the reviewed one.
export async function recheckCandidateBinding(repositoryRoot, initial) {
  const current = prepareCandidateArchive(repositoryRoot);
  return runWithCleanup(async () => {
    if (['commit', 'manifestSha256', 'archiveSha256'].some((key) => current[key] !== initial[key])) {
      throw new Error('candidate changed since initial review; marker was not emitted');
    }
    return true;
  }, [() => current.cleanup()]);
}

export async function runManualActiveTabQa(argv = process.argv.slice(2), { prepare = prepareCandidateArchive, review = reviewCandidate } = {}) {
  parseArguments(argv);
  const candidate = prepare(root);
  await runWithCleanup(() => review(candidate), [() => candidate.cleanup()]);
}

export async function reviewCandidate(candidate, {
  createTls = createFixtureTls, makeServer = createServer, createProfile = mkdtemp,
  launchContext = (...args) => chromium.launchPersistentContext(...args), removeProfile = rm,
} = {}) {
  const { extensionPath } = candidate;
  let tls;
  let server;
  let profile;
  let context;
  let terminal;
  await runWithCleanup(async () => {
    tls = await createTls();
    const fixtures = { clean: mockCheckoutHtml(), dynamic: mockCheckoutHtml(true) };
    server = makeServer({ key: tls.key, cert: tls.cert }, (request, response) => {
      serveFixture(request.url, response, fixtures);
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not expose a TCP port');
    const fixtureOrigin = fixtureOriginForServerAddress(address);

    profile = await createProfile(resolve(tmpdir(), 'clearchoice-manual-active-tab-'));
    context = await launchContext(profile, reviewBrowserLaunchOptions(extensionPath, tls.pin));
    const cleanPage = await context.newPage();
    await cleanPage.goto(`${fixtureOrigin}/checkout/clean`);
    await captureIntegrityBaseline(cleanPage);
    await cleanPage.bringToFront();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const cleanUrl = `${fixtureOrigin}/checkout/clean`;
    const readClean = async (mode) => {
      const predicates = await worker.evaluate(`(${observeCleanState.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(cleanUrl)})`);
      if (!predicates.storageValid || !predicates.unchanged || !predicates.badgeBlank
        || ['historyCount', 'subscriptionCount', 'permissionCount', 'scriptCount', 'grantCount'].some((key) => predicates[key] !== 0)) {
        throw new Error('clean zero storage, badge or detection-state predicate failed');
      }
    };
    await readClean('capture');

    process.stdout.write('\nManual active-tab QA is waiting. In the runner-provided visible Chromium window:\n');
    process.stdout.write('That Chromium can access only the two HTTPS reserved .test fixtures mapped to 127.0.0.1 and the extension; its dead proxy blocks every other host including alternate loopback hosts, so it cannot validate real sites. This boundary applies only to Chromium launched by this runner, not other browser instances.\n');
    process.stdout.write('The runner retains only SHA-256 integrity digests and panel/integrity pass-fail predicates; it never writes or prints page data.\n\n');
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    let dynamicPage;
    await runManualCheckpoints({
      cleanPage,
      getDynamicPage: () => dynamicPage,
      instruct: (text) => process.stdout.write(`${text}\n`),
      waitForPanel,
      assertIntegrity,
      confirmCleanAnalyze: async () => {
        // Observe the genuine popup outcome; a quiet page alone cannot prove Analyze.
        const isPopup = (page) => page.url().startsWith('chrome-extension://') && page.url().endsWith('/popup/index.html');
        const popup = context.pages().find(isPopup) ?? await context.waitForEvent('page', { predicate: isPopup, timeout: 300_000 });
        await popup.locator('main > p[role="status"]').filter({ hasText: /^No matching signals found on this page\.$/ }).waitFor({ timeout: 300_000 });
        if (await terminal.question('Leave the popup open. Type DONE only after the real Analyze reports no findings: ') !== 'DONE') throw new Error('clean Analyze not acknowledged');
      },
      assertCleanQuiet: async (page) => {
        if (await page.locator('aside[data-clearchoice-panel]').count() !== 0) throw new Error('clean zero displayed a panel');
        await readClean('compare');
      },
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
    throw new Error('expanded opt-in, history, subscription, retention and cancellation-help stages are pending; no ATTEST or marker is available');
  }, [
    () => terminal?.close(),
    () => context?.close(),
    () => server && closeServer(server),
    () => profile && removeProfile(profile, { recursive: true, force: true }),
    () => tls?.cleanup(),
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runManualActiveTabQa();
  } catch (error) {
    process.stderr.write(`manual active-tab QA failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
