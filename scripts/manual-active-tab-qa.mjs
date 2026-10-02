/* global window, location, document, chrome, setTimeout, clearTimeout, AbortSignal */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createFixtureTls, mockCheckoutHtml } from './manual-qa-fixtures.mjs';
import { LOCAL_HUMAN_ATTESTATION, WORKFLOW_PREDICATES, validateManualActiveTabMarker, sha256 } from './active-tab-qa.mjs';
import { storageValidatorSource, observeAutomaticLifecycle, observeFinalState, observeFinalUi, observeCleanState, observeSiteState, observeHistorySubscriptions, observeHistorySubscriptionUi, runHumanStage, waitForObservation, runWithCleanup } from './manual-qa-stages.mjs';
import { prepareCandidateArchive } from './release-artifact.mjs';

const root = resolve(import.meta.dirname, '..');

const fixtureOriginPattern = /^https:\/\/checkout-a\.test:([1-9]\d{0,4})$/;

export function fixtureForRequest(url) {
  if (url === '/checkout/clean') return 'clean';
  if (url === '/checkout/dynamic-beta') return 'dynamic';
  if (url === '/checkout/identical') return 'identical';
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

export function restrictedBrowserArgs() {
  return [
    '--enable-unsafe-extension-debugging',
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
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [...restrictedBrowserArgs(extensionDirectory), ...(pin ? [`--ignore-certificate-errors-spki-list=${pin}`] : [])],
  };
}

// Linux Chromium derives an unpacked extension ID from its canonical directory.
// Bind to the reviewed bytes, not the first (possibly unrelated) worker target.
export async function reviewedWorkerUrl(extensionDirectory) {
  const directory = await realpath(extensionDirectory);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  if (manifest.key || manifest.background?.service_worker !== 'worker.js') throw new Error('unexpected reviewed worker manifest');
  const id = sha256(directory).slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
  return `chrome-extension://${id}/worker.js`;
}

export async function waitForReviewedExtensionWorker(context, extensionDirectory, { timeoutMs = 5_000 } = {}) {
  const url = await reviewedWorkerUrl(extensionDirectory);
  const session = await context.newCDPSession(context.pages()[0]);
  let timer;
  let onVersion;
  return runWithCleanup(async () => {
    // A Playwright worker target can precede Chromium's extension installation.
    // Observe activation of THIS script; no sleeps or retries of failed readback.
    const activated = new Promise((resolveActivated, reject) => {
      timer = setTimeout(() => reject(new Error('reviewed extension worker activation timed out')), timeoutMs);
      onVersion = ({ versions }) => {
        if (versions.some((version) => version.scriptURL === url && version.status === 'activated' && version.runningStatus === 'running')) resolveActivated();
      };
      session.on('ServiceWorker.workerVersionUpdated', onVersion);
    });
    await Promise.all([session.send('ServiceWorker.enable'), activated]);
    const worker = context.serviceWorkers().find((item) => item.url() === url)
      ?? await context.waitForEvent('serviceworker', { predicate: (item) => item.url() === url, timeout: timeoutMs });
    const ready = await worker.evaluate((expectedUrl) => {
      const api = globalThis.chrome;
      return globalThis.location.href === expectedUrl && api?.runtime?.getURL('worker.js') === expectedUrl
        && typeof api.storage?.local?.get === 'function'
        && typeof api.permissions?.getAll === 'function'
        && typeof api.scripting?.getRegisteredContentScripts === 'function'
        && typeof api.tabs?.query === 'function' && typeof api.action?.getBadgeText === 'function';
    }, url);
    if (ready !== true) throw new Error('reviewed extension worker browser APIs unavailable');
    return worker;
  }, [
    () => { clearTimeout(timer); },
    () => { if (onVersion) session.off('ServiceWorker.workerVersionUpdated', onVersion); },
    () => session.detach(),
  ]);
}

export async function installReviewedExtension(context, extensionDirectory) {
  const session = await context.browser().newBrowserCDPSession();
  return runWithCleanup(async () => {
    const { id } = await session.send('Extensions.loadUnpacked', { path: await realpath(extensionDirectory) });
    if (id !== new URL(await reviewedWorkerUrl(extensionDirectory)).hostname) throw new Error('installed extension identity mismatch');
    return id;
  }, [() => session.detach()]);
}

export async function wakeReviewedExtension(context, extensionDirectory) {
  const page = await context.newPage();
  return runWithCleanup(async () => {
    await page.goto(new URL('/popup/index.html', await reviewedWorkerUrl(extensionDirectory)).href);
    // Wake only; this is not a native action popup or human gesture checkpoint.
    await page.evaluate(() => chrome.runtime.getPlatformInfo());
  }, [() => page.close()]);
}

export async function runFinalCheckpoints({ instruct, acknowledge, read, ui, integrity, restart, quiet, waitForState = waitForObservation }) {
  if (!await read('baseline')) throw new Error('final baseline predicate failed');
  const stage = async (instruction, mode, visible) => {
    const observe = async () => await ui(visible) && await read(mode);
    await runHumanStage({ instruction, instruct, acknowledge, observe: () => waitForState(observe) });
    if (!await observe()) throw new Error('final state changed during acknowledgement');
    await integrity();
  };
  await stage('30. RETENTION: human-select 7 days in Keep local observations. Leave popup open. Confirmed subscription and fresh history must stay unchanged; this does NOT prove elapsed expiry.', 'retention', 'retention');
  await stage('31. HELP NEGATIVE BOUNDARY: click Cancellation help on QA Finding Mock. Confirm No known provider site; check your billing provider, NO anchor, and local deletion does not cancel billing. The mock port is rejected by production policy; positive Visit site fallback and official guides remain UNVERIFIED. Do not open a provider or sign in.', 'unchanged', 'help');
  instruct('32. RESTART: type DONE to authorize closing this runner browser and reopening the SAME profile without reinstalling the extension.');
  if (await acknowledge() !== 'DONE') throw new Error('restart authorization missing');
  if (!await read('unchanged')) throw new Error('pre-restart state mismatch');
  await integrity();
  await restart();
  if (!await read('unchanged') || !await quiet()) throw new Error('restart durability predicate failed');
  await stage('33. RESTART READBACK: human-open the toolbar popup. Confirm 7 days, retained reviewed history and one saved QA Finding Mock subscription; automatic detection remains off. Leave popup open.', 'unchanged', 'restart');
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
      href: window.__qaLifecycleIntegrity && ['/checkout/identical', '/information'].includes(location.pathname) ? location.origin + '/checkout/identical' : location.href,
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

export async function captureIntegrityBaseline(page, lifecycle = false) {
  await page.evaluate((value) => { window.__qaLifecycleIntegrity = value; }, lifecycle);
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

// This slice deliberately returns no attestation predicates or marker.
export async function runSiteCheckpoints({ instruct, acknowledge, navigate, read, quiet, positive, denied, integrity, mutate, lifecycle }) {
  const stage = async (instruction, observe) => {
    await runHumanStage({ instruction, instruct, observe, acknowledge });
    if (!await observe()) throw new Error('site state changed during acknowledgement');
  };
  await navigate('a', false);
  await read('baseline', 'a');
  await stage('13. A CLEAN: pointer-click toolbar, then Enable detection for this site. ALLOW the real Chrome permission prompt. Leave popup open; no simulated permission is accepted.', async () => await read('enabled', 'a') && await quiet('a'));
  await integrity('a');
  await navigate('a', true);
  await stage('14. A POSITIVE: do not press Analyze or Save. Observe automatic recurring findings, panel and badge; acknowledge only after they appear.', async () => await read('positive', 'a') && await positive('a'));
  await integrity('a');
  await navigate('b', true);
  await read('baseline', 'b');
  if (!await read('quiet', 'b') || !await quiet('b')) throw new Error('unopted B isolation predicate failed');
  await integrity('b');
  await stage('15. B DENIAL: pointer-click toolbar, then Enable detection for this site. DENY the real Chrome permission prompt. Keep popup open with Access denied status. If Chrome offers no genuine prompt, abort; do not simulate it.', async () => await denied() && await read('quiet', 'b') && await quiet('b'));
  await integrity('b');
  await navigate('a', true);
  if (!await read('positive', 'a') || !await positive('a')) throw new Error('automatic A revisit predicate failed');
  await lifecycle();
  await read('before-revoke', 'a');
  await stage('16. A REVOKE: pointer-click toolbar, then Disable detection for this site. Wait for panel and badge to clear.', async () => await read('revoked', 'a') && await quiet('a'));
  await integrity('a');
  instruct('17. A REVOKED: pointer-click Replace fake order summary. Detection must remain off.');
  await mutate();
  if (!await read('revoked', 'a') || !await quiet('a')) throw new Error('revoked mutation predicate failed');
  await integrity('a');
  await navigate('a', true);
  if (!await read('revoked', 'a') || !await quiet('a')) throw new Error('revoked revisit predicate failed');
  await integrity('a');
}

export async function runAutomaticLifecycleCheckpoints({ instruct, acknowledge, read, ui, navigate, reload, integrity, waitForState = waitForObservation }) {
  if (!await read('baseline')) throw new Error('automatic lifecycle baseline failed');
  const stage = async (instruction, mode, visible) => {
    const observe = async () => await ui(visible) && await read(mode);
    await runHumanStage({ instruction, instruct, acknowledge, observe: () => waitForState(observe) });
    if (!await observe()) throw new Error('automatic lifecycle changed during acknowledgement');
    await integrity();
  };
  instruct('15a. AUTOMATIC IDENTICAL: runner navigates to two identical mock paragraphs. Do not Analyze or Save; observe two findings and badge 2, zero subscriptions.');
  await navigate();
  await stage('15b. DISTINCT: acknowledge only after both identical findings appear automatically.', 'distinct', 'two');
  await stage('15c. REPEAT: human-click Replace fake order summary twice. Both findings and IDs must remain distinct without new history or subscriptions.', 'repeat', 'mutated');
  instruct('15d. RELOAD: type DONE to authorize runner reload of the same controlled mock.');
  if (await acknowledge() !== 'DONE') throw new Error('lifecycle reload authorization missing');
  if (!await read('repeat')) throw new Error('pre-reload lifecycle changed');
  await reload();
  await stage('15e. RELOADED: without Analyze or Save, observe two automatic findings; identities and history count must be unchanged.', 'repeat', 'two');
  if (!await read('before-exit')) throw new Error('SPA exit baseline failed');
  await stage('15f. SPA EXIT: human-click Exit checkout route. Panel must disappear and badge clear while history persists.', 'exit', 'exit');
  await stage('15g. SPA RETURN: human-click Return to checkout route. Two automatic findings and badge 2 must return without duplicate history.', 'repeat', 'two');
}

// No workflow result/attestation is produced by this bounded human-only slice.
export async function runHistorySubscriptionCheckpoints({ instruct, acknowledge, read, ui, waitForState = waitForObservation }) {
  if (!await read('baseline')) throw new Error('human CRUD baseline predicate failed');
  const stage = async (instruction, mode, visible) => {
    const observe = async () => await ui(visible) && await read(mode);
    await runHumanStage({ instruction, instruct, acknowledge, observe: () => waitForState(observe) });
    if (!await observe()) throw new Error('human CRUD state changed during acknowledgement');
  };
  await stage('18. HISTORY: human-open the toolbar popup and click Refresh history. Confirm retained A recurring observations remain usable after revoke; subscriptions must still be empty. Leave popup open.', 'history', 'history');
  await stage('19. HISTORY: click Mark reviewed on the first unreviewed A recurring-charge observation. Confirm Reviewed and the disabled Mark reviewed button. This must NOT create a subscription.', 'reviewed', 'reviewed');
  await stage('20. DRAFT: on that same Reviewed observation click Review as subscription. Observe Confirm observation as subscription; Merchant, Amount, Currency and Cadence must all be blank. Do not Save.', 'unchanged', 'draft');
  await stage('21. CANCEL: click Cancel in the subscription editor. Observe Editor closed; no additional save requested. No storage mutation is allowed.', 'unchanged', 'cancelled');
  await stage('22. REOPEN: click Review as subscription on the same observation. Observe the same four blank fields again.', 'unchanged', 'draft');
  await stage('23. CONFIRM: human-fill only fake Merchant QA Finding Mock, Amount 12.34, Currency USD, Cadence monthly; leave optional fields blank. Click Save subscription. Observe Subscription saved locally. Exactly one record must persist with the correct finding provenance.', 'confirmed', 'saved-one');
  if (!await read('history-delete-baseline')) throw new Error('history delete baseline failed');
  await stage('23a. HISTORY DELETE CANCEL: on the OTHER unreviewed recurring observation (not the Reviewed subscription source), click Delete. In the native Permanently delete observation confirmation choose Cancel. Leave popup open; all history and subscriptions must remain unchanged.', 'history-delete-cancelled', 'history-delete-cancelled');
  await stage('23b. HISTORY DELETE CONFIRM: click Delete on that SAME other unreviewed observation again; approve the native confirmation. Only that observation may disappear; the Reviewed source and its confirmed subscription must remain unchanged.', 'history-deleted', 'history-deleted');
  await stage('24. MANUAL ADD: click Add subscription. Human-fill only fake Merchant QA Manual Mock, Amount 23.45, Currency USD, Cadence yearly; leave optional fields blank. Click Save subscription. The finding-confirmed record must remain unchanged.', 'added', 'saved-two');
  await stage('25. EDIT: click Edit on QA Manual Mock ONLY. Change fake Merchant to QA Manual Mock Edited, Amount to 34.56, Cadence to weekly; keep USD and optional fields blank. Click Save subscription. Identity and provenance must be preserved.', 'edited', 'saved-two');
  await stage('26. DELETE PROMPT: click Delete on QA Manual Mock Edited ONLY. Observe Delete subscription? for that fake target; do not confirm yet.', 'unchanged', 'delete-prompt');
  await stage('27. DELETE CANCEL: click Cancel in Delete confirmation. Both persisted subscriptions must remain byte-for-byte unchanged.', 'unchanged', 'closed-two');
  await stage('28. DELETE REOPEN: click Delete on QA Manual Mock Edited ONLY again. Observe the correct Delete confirmation target.', 'unchanged', 'delete-prompt');
  await stage('29. DELETE CONFIRM: click Delete subscription in Delete confirmation. Observe Subscription deleted locally. Only the manual record may disappear; the finding-confirmed subscription and retained history must survive.', 'deleted', 'deleted-one');
}

export function stopPendingHumanStages() {
  throw new Error('final human attestation pending review; no ATTEST or marker is available');
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
  install = installReviewedExtension,
} = {}) {
  const { extensionPath } = candidate;
  let tls;
  let server;
  let profile;
  let context;
  let terminal;
  await runWithCleanup(async () => {
    tls = await createTls();
    const fixtures = { clean: mockCheckoutHtml(), dynamic: mockCheckoutHtml(true), identical: mockCheckoutHtml('identical') };
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
    // Observe native confirmations without auto-accept/dismiss; only the human responds.
    context.on('dialog', () => {});
    await install(context, extensionPath);
    const cleanPage = await context.newPage();
    await cleanPage.goto(`${fixtureOrigin}/checkout/clean`);
    await captureIntegrityBaseline(cleanPage);
    await cleanPage.bringToFront();
    let worker = await waitForReviewedExtensionWorker(context, extensionPath);
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
    const pages = { a: dynamicPage };
    const origins = { a: fixtureOrigin, b: fixtureOrigin.replace('checkout-a.test', 'checkout-b.test') };
    const popupUrl = new URL('/popup/index.html', worker.url()).href;
    const validateStorage = await storageValidatorSource();
    const siteRead = async (mode, site) => {
      if (new URL(pages[site].url()).origin !== origins[site]) throw new Error('mock page origin changed');
      const observe = async () => (await worker.evaluate(`(${observeSiteState.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(origins[site])}, globalThis, ${validateStorage})`)).passed;
      if (['baseline', 'before-revoke'].includes(mode)) return observe();
      await waitForObservation(observe);
      if (['quiet', 'revoked'].includes(mode)) {
        // Observe a bounded quiet interval, not merely a single early sample.
        for (let sample = 0; sample < 5; sample++) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 200));
          if (!await observe()) throw new Error('quiet site changed during observation');
        }
      }
      return true;
    };
    await runSiteCheckpoints({
      instruct: (text) => process.stdout.write(`${text}\n`),
      acknowledge: () => terminal.question('Type DONE only after the requested real human action and observation (anything else aborts): ', { signal: AbortSignal.timeout(300_000) }),
      navigate: async (site, positive) => {
        pages[site] ??= await context.newPage();
        await pages[site].goto(`${origins[site]}/checkout/${positive ? 'dynamic-beta#checkout' : 'clean'}`);
        await captureIntegrityBaseline(pages[site]);
        await pages[site].bringToFront();
      },
      lifecycle: () => runAutomaticLifecycleCheckpoints({
        instruct: (text) => process.stdout.write(`${text}\n`),
        acknowledge: () => terminal.question('Type DONE after the requested automatic lifecycle observation: ', { signal: AbortSignal.timeout(300_000) }),
        read: async (mode) => {
          const observe = async () => {
            if (!await siteRead('before-revoke', 'a')) return false;
            return (await worker.evaluate(`(${observeAutomaticLifecycle.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(origins.a)}, globalThis, ${validateStorage})`)).passed;
          };
          if (!await observe()) return false;
          if (['repeat', 'exit'].includes(mode)) {
            for (let sample = 0; sample < 5; sample++) {
              await new Promise((resolveWait) => setTimeout(resolveWait, 200));
              if (!await observe()) return false;
            }
          }
          return true;
        },
        navigate: async () => { await pages.a.goto(`${origins.a}/checkout/identical`); await captureIntegrityBaseline(pages.a, true); },
        reload: async () => { await pages.a.reload(); await captureIntegrityBaseline(pages.a, true); },
        integrity: () => assertIntegrity(pages.a, 'automatic lifecycle'),
        ui: async (mode) => {
          const count = await pages.a.locator('aside[data-clearchoice-panel] article').count();
          if (mode === 'exit') return new URL(pages.a.url()).pathname === '/information' && count === 0 && await pages.a.locator('aside[data-clearchoice-panel]').count() === 0;
          return new URL(pages.a.url()).pathname === '/checkout/identical' && count === 2
            && (mode !== 'mutated' || await pages.a.locator('#fake-order-summary h2').textContent() === 'Order summary updated again');
        },
      }),
      read: siteRead,
      quiet: async (site) => await pages[site].locator('aside[data-clearchoice-panel]').count() === 0,
      positive: async (site) => {
        await waitForPanel(pages[site], 'attached');
        return await pages[site].locator('aside[data-clearchoice-panel]').count() === 1;
      },
      denied: async () => {
        // Exact production status, from the genuine action popup, precedes DONE.
        const popup = context.pages().find((page) => page.url() === popupUrl)
          ?? await context.waitForEvent('page', { predicate: (page) => page.url() === popupUrl, timeout: 300_000 });
        await popup.locator('[data-site-status]').filter({ hasText: `Access denied for ${origins.b}; detection remains off.` }).waitFor({ timeout: 300_000 });
        return await popup.locator('[data-site-status]').textContent() === `Access denied for ${origins.b}; detection remains off.`;
      },
      integrity: (site) => assertIntegrity(pages[site], 'site permission checkpoint'),
      mutate: async () => {
        await pages.a.waitForFunction(() => document.querySelector('#fake-order-summary')?.textContent?.includes('updated') === true, undefined, { timeout: 300_000 });
      },
    });
    let targetDigest;
    let deleteDigest;
    await runHistorySubscriptionCheckpoints({
      instruct: (text) => process.stdout.write(`${text}\n`),
      acknowledge: () => terminal.question('Type DONE only after the requested human popup action and observed result: ', { signal: AbortSignal.timeout(300_000) }),
      read: async (mode) => {
        const result = await worker.evaluate(`(${observeHistorySubscriptions.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(origins.a)}, globalThis, ${validateStorage})`);
        if (mode === 'baseline') targetDigest = result.targetDigest;
        if (mode === 'history-delete-baseline') deleteDigest = result.deleteDigest;
        return result.passed;
      },
      ui: async (mode) => {
        const popup = context.pages().find((page) => !page.isClosed() && page.url() === popupUrl);
        if (!popup) return false;
        return popup.evaluate(`(${observeHistorySubscriptionUi.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(targetDigest)}, ${JSON.stringify(deleteDigest)})`);
      },
    });
    const expectedWorkerUrl = await reviewedWorkerUrl(extensionPath);
    let finalBaseline;
    const readFinal = async (mode) => worker.evaluate(`(${observeFinalState.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(origins.a)}, ${JSON.stringify(expectedWorkerUrl)}, ${JSON.stringify(finalBaseline)}, ${validateStorage})`);
    const uiFinal = async (mode) => {
      const popup = context.pages().find((page) => !page.isClosed() && page.url() === popupUrl);
      return popup ? popup.evaluate(`(${observeFinalUi.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(origins.a)})`) : false;
    };
    await runFinalCheckpoints({
      instruct: (text) => process.stdout.write(`${text}\n`),
      acknowledge: () => terminal.question('Type DONE after the requested human action/observation: ', { signal: AbortSignal.timeout(300_000) }),
      read: async (mode) => {
        if (mode === 'baseline') { finalBaseline = await readFinal(mode); return true; }
        const passed = await readFinal(mode);
        if (passed && mode === 'retention') finalBaseline = { ...finalBaseline, policy: 7 };
        return passed;
      },
      ui: uiFinal,
      integrity: () => assertIntegrity(pages.a, 'final checkpoint'),
      restart: async () => {
        await context.close();
        context = await launchContext(profile, reviewBrowserLaunchOptions(extensionPath, tls.pin));
        // Same profile, no extension reinstall, same servers and pinned certificate.
        pages.a = await context.newPage();
        await pages.a.goto(`${origins.a}/checkout/dynamic-beta#checkout`);
        await captureIntegrityBaseline(pages.a);
        await pages.a.bringToFront();
        await wakeReviewedExtension(context, extensionPath);
        worker = await waitForReviewedExtensionWorker(context, extensionPath);
      },
      quiet: async () => await pages.a.locator('aside[data-clearchoice-panel]').count() === 0,
    });
    stopPendingHumanStages();
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
