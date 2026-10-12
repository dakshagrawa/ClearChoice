/* global window, location, document, chrome, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal, crypto, TextEncoder */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { syntheticNativePopup } from './synthetic-native-popup.mjs';
import { passiveNativePopup, readNativePopup, waitForNativePopup } from './passive-native-popup.mjs';
import { createFixtureTls, mockCheckoutHtml } from './manual-qa-fixtures.mjs';
import { LOCAL_HUMAN_ATTESTATION, MIXED_EVIDENCE, WORKFLOW_PREDICATES, validateManualActiveTabMarker, sha256 } from './active-tab-qa.mjs';
import { storageValidatorSource, observePermissionCycle, observeAutomaticLifecycle, observeFinalState, observeFinalUi, observeCleanState, observeSiteState, observeHistorySubscriptions, observeHistorySubscriptionUi, runHumanStage, waitForObservation, runWithCleanup } from './manual-qa-stages.mjs';
import { armHumanDenial } from './human-denial-evidence.mjs';
import { prepareCandidateArchive } from './release-artifact.mjs';
import { createQaRunLog, createQaMismatchMonitor, checkpointId, acknowledgementToken } from './manual-qa-run-log.mjs';

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
    // A human may tile/resize this window. Playwright's default 1280x720
    // emulation otherwise leaves fixed panels outside the physically visible tab.
    viewport: null,
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
    await runHumanStage({ instruction: instruction + ' If closed after the previous DONE, human-open the toolbar popup for this new step.', instruct, acknowledge, observe: () => waitForState(observe) });
    // This action popup may be destroyed by terminal focus. Its exact transient
    // UI is mandatory before DONE; only durable state is read again afterwards.
    if (!await read(mode)) throw new Error('final state changed during acknowledgement');
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

async function integrityDigests(page) {
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
  // One coherent snapshot, transient raw data only. Retain digests, never values.
  const { href, forms, controls, hostNodes } = JSON.parse(snapshot);
  const components = { href, forms, controlIdentity: controls.map(row => row.slice(0, 3)),
    controlValues: controls.map(row => row[3]), controlChecked: controls.map(row => row[4]),
    controlDisabled: controls.map(row => row[5]), hostNodes };
  return { digest: sha256(snapshot), componentDigests: Object.fromEntries(
    Object.entries(components).map(([key, value]) => [key, sha256(JSON.stringify(value))])) };
}

export async function captureIntegrityBaseline(page, lifecycle = false) {
  await page.evaluate((value) => { window.__qaLifecycleIntegrity = value; }, lifecycle);
  const digests = await integrityDigests(page);
  await page.evaluate((value) => {
    window.__clearchoiceManualIntegrityBaseline = {
      ...value,
      predicates: { integrity: true, ...Object.fromEntries(Object.keys(value.componentDigests).map(key => [key, true])) },
    };
  }, digests);
}

export async function integrityPassed(page) {
  const digests = await integrityDigests(page);
  return page.evaluate((value) => {
    const baseline = window.__clearchoiceManualIntegrityBaseline;
    if (!baseline) return false;
    const passed = value.digest === baseline.digest;
    baseline.predicates.integrity &&= passed;
    for (const [key, digest] of Object.entries(value.componentDigests)) {
      baseline.predicates[key] &&= digest === baseline.componentDigests[key];
    }
    return passed;
  }, digests);
}

export async function assertIntegrity(page, phase) {
  if (!(await integrityPassed(page))) {
    // Bounded passive diagnostics only. No URLs, controls, text or records.
    const predicates = await page.evaluate(() => Object.fromEntries(
      ['integrity', 'href', 'forms', 'controlIdentity', 'controlValues', 'controlChecked', 'controlDisabled', 'hostNodes']
        .map(key => [key, window.__clearchoiceManualIntegrityBaseline?.predicates?.[key] === true])));
    throw new Error(`manual ${phase} integrity predicate failed; unchanged=${JSON.stringify(predicates)}`);
  }
}

// Passive, mock-only diagnostics: no text, URLs, finding IDs, records or input.
// The shadow host itself has zero-sized bounds even when its fixed child renders.
export function observeMockPanelGeometry() {
  if (!/^https:\/\/checkout-[ab]\.test:([1-9]\d{0,4})$/.test(location.origin)) throw new Error('panel diagnostics require a controlled mock fixture');
  const panels = document.querySelectorAll('aside[data-clearchoice-panel]');
  const host = panels.length === 1 ? panels[0] : null;
  const root = host?.shadowRoot;
  const section = root?.querySelector('.clearchoice-panel');
  const dismiss = root?.querySelector('[data-clearchoice-dismiss]');
  const bounds = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const rect = dismiss?.getBoundingClientRect();
  const visible = dismiss?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true;
  const enabled = !!dismiss && !dismiss.disabled;
  const inViewport = !!rect && rect.width > 0 && rect.height > 0
    && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
  const pointerHit = inViewport && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === host
    && root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === dismiss;
  return { uniquePanel: panels.length === 1, dismissPresent: !!dismiss, visible, enabled, inViewport, pointerHit,
    reachable: visible && enabled && inViewport && pointerHit,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    hostBounds: bounds(host), panelBounds: bounds(section), dismissBounds: bounds(dismiss) };
}

export async function waitForPanel(page, state, {
  timeoutMs = 300_000,
  report = (geometry) => { process.stdout.write(`Mock panel geometry (passive; not human evidence): ${JSON.stringify(geometry)}\n`); },
} = {}) {
  assertFixtureOrigin(new URL(page.url()).origin);
  if (state === 'detached') {
    await page.locator('aside[data-clearchoice-panel]').waitFor({ state, timeout: timeoutMs });
    return;
  }
  if (state !== 'attached') throw new Error('unsupported manual panel state');
  try {
    await page.locator('aside[data-clearchoice-panel]').waitFor({ state, timeout: timeoutMs });
    const geometry = await page.evaluate(observeMockPanelGeometry);
    report(geometry);
    if (!geometry.reachable) {
      await page.waitForFunction(`(${observeMockPanelGeometry.toString()})().reachable`, undefined, { timeout: timeoutMs });
      report(await page.evaluate(observeMockPanelGeometry));
    }
  } catch {
    const geometry = await page.evaluate(observeMockPanelGeometry).catch(() => ({ diagnosticUnavailable: true }));
    report(geometry);
    throw new Error(`manual panel checkpoint failed: Dismiss is not visibly reachable; geometry=${JSON.stringify(geometry)}`);
  }
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
  const stage = async (instruction, observe, recheck = observe) => {
    await runHumanStage({ instruction, instruct, observe, acknowledge });
    if (!await recheck()) throw new Error('site state changed during acknowledgement');
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
  // Fresh real request evidence, NOT a browser-observed false-result callback.
  const denial = await denied();
  if (!denial || !['observed', 'passed', 'close'].every(key => typeof denial[key] === 'function')) throw new Error('correlated denial request observer unavailable');
  const deniedQuiet = async () => await read('quiet', 'b') && await quiet('b');
  await runWithCleanup(async () => {
    instruct('15. B DENIAL: pointer-click Enable detection for this site in the prepared B popup, then DENY the genuine Chrome permission prompt. The popup may disappear. After real Deny, type DENIED when asked. This is humanReportedDenial plus correlated request/isolation, NOT browserObserved denial or a false-result callback. If no real prompt appears, abort.');
    if (!await denial.observed() || !await denial.passed() || !await deniedQuiet()) throw new Error('fresh B permission request/isolation not observed');
    if (await acknowledge('DENIED') !== 'DENIED') throw new Error('human DENIED acknowledgement missing');
    if (!await denial.passed() || !await deniedQuiet()) throw new Error('site state changed during acknowledgement');
    await integrity('b');
  }, [() => denial.close()]);
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

// Human re-enable action plus verified state, not a claim of fresh Chrome consent.
// Initial genuine Allow remains mandatory in step 13; no prompt/input automation.
export async function runPermissionCycleCheckpoints({ instruct, acknowledge, read, ui, integrity, waitForState = waitForObservation }) {
  if (!await read('baseline')) throw new Error('permission cycle baseline failed');
  const stage = async (instruction, mode, visible, token) => {
    instruct(instruction);
    const observe = async (afterAcknowledgement = false) => await ui(visible, { afterAcknowledgement }) && await read(mode);
    if (!await waitForState(observe)) throw new Error('permission cycle observable predicate failed');
    if (await acknowledge(token) !== token) throw new Error('permission cycle human acknowledgement missing');
    if (!await observe(true)) throw new Error('permission cycle changed during acknowledgement');
    await integrity();
  };
  await stage('17a. REENABLE A: human-open the real toolbar popup and pointer-click Enable detection for this site. Chrome usually restores previously approved access without prompting after permissions.remove(); a new dialog is NOT required. Click Allow only if Chrome actually shows a permission dialog. Do not Analyze or Save. Leave popup open and observe enabled status, automatic panel and badge 1. Type REENABLE_CONFIRMED only after your real Enable click and those observations. This is human re-enable action plus verified state, NOT a new Chrome Allow attestation or automated proof of your click. Do not simulate or seed permission.', 'reenabled', 'enabled', 'REENABLE_CONFIRMED');
  if (!await read('before-settings')) throw new Error('Settings removal baseline failed');
  await stage('17b. CHROME SETTINGS REMOVE A: in THIS runner window only, human-open a separate chrome://extensions tab, find ClearChoice > Details > Site access. Chrome versions may show On specific sites with a site menu/Remove, or a Site access dropdown. Remove the A mock site permission through Chrome controls; never use the production popup Disable button. Do not uninstall/reload the extension or remove B instead. If this Chrome cannot remove this specific port-bearing mock origin, STOP with Ctrl+C, report the limitation, close the disposable runner and rerun only after a compatible Chrome/site-access remedy; do not broaden access or use permissions.remove automation. Return to the original A mock tab (do not reload), leave Settings, and observe panel gone and blank badge. Type CHROME_SETTINGS_A_REMOVED only after that actual Chrome Settings action.', 'settings-removed', 'quiet', 'CHROME_SETTINGS_A_REMOVED');
  return { reenableEvidence: MIXED_EVIDENCE.reenableEvidence };
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
export async function runHistorySubscriptionCheckpoints({ instruct, acknowledge, read, ui, nativeDialog, prepareNativePopup, integrity, waitForState = waitForObservation }) {
  if (!await read('baseline')) throw new Error('human CRUD baseline predicate failed');
  const pendingAcknowledgements = [];
  let pairedIdentity;
  const stage = async (instruction, mode, visible) => {
    const deletion = ['history-delete-cancelled', 'history-deleted'].includes(mode);
    if (deletion && typeof nativeDialog !== 'function') throw new Error('native history dialog observer unavailable');
    if (deletion) await prepareNativePopup?.();
    const dialog = deletion ? await nativeDialog(mode === 'history-deleted') : undefined;
    await runWithCleanup(async () => {
      const observe = async () => {
        if (dialog && !await dialog.passed()) return false;
        let identity;
        const passed = await ui(visible, { onIdentity: value => { identity = value; } });
        const paired = pendingAcknowledgements.length > 0 || ['draft', 'delete-prompt'].includes(visible);
        if (paired && passed) {
          if (!identity || (pairedIdentity && identity !== pairedIdentity)) throw new Error('paired popup document changed or unavailable');
          pairedIdentity = identity;
        }
        return passed && await read(mode);
      };
      instruct(instruction + (pendingAcknowledgements.length === 0 ? ' If closed after the previous DONE, human-open the toolbar popup for this new step.' : ' Keep this same popup open; follow this next action before returning to the terminal.')
        + (['draft', 'delete-prompt'].includes(visible) ? ' Stay in the popup: the next numbered action follows automatically; both separate DONE acknowledgements come after that action.' : ''));
      if (await waitForState(observe) !== true) throw new Error('human stage observable predicate failed');
      pendingAcknowledgements.push(instruction);
      // Release the observer before terminal focus: a live CDP attachment can
      // itself pin Chromium's native popup and distort the human lifecycle.
      if (dialog) await dialog.seal();
      // Draft/delete-prompt UI cannot survive terminal focus. Observe its next
      // numbered action before asking for either separate human DONE. No popup
      // is reopened or reconstructed by the runner, and no click is repeated.
      if (['draft', 'delete-prompt'].includes(visible)) return;
      while (pendingAcknowledgements.length > 0) {
        if (await acknowledge(pendingAcknowledgements[0]) !== 'DONE') throw new Error('human stage acknowledgement missing');
        // The latest stage's exact durable state includes the legitimate next
        // action in the same editor. Rechecking an earlier draft's storage here
        // would incorrectly reject its subsequent explicit Save.
        if ((dialog && !await dialog.passed({ afterAcknowledgement: true })) || !await read(mode)) throw new Error('human CRUD state changed during acknowledgement');
        await integrity();
        pendingAcknowledgements.shift();
        if (!pendingAcknowledgements.length) pairedIdentity = undefined;
      }
    }, [() => dialog?.close()]);
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

// Passive native CDP observation. A fresh session and click checkpoint are bound
// to exactly one genuine popup; no confirm replacement or dialog response exists.
export async function observeNativeHistoryDialog(context, popup, targetDigest, messageDigest, accepted) {
  if (!popup || popup.isClosed() || ![targetDigest, messageDigest].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error('native history dialog target unavailable');
  const session = popup.session ?? await context.newCDPSession(popup);
  const state = { opening: 0, closed: 0, type: '', digest: '', accepted: null };
  let evidence;
  const opening = (event) => {
    state.opening++;
    state.type = event.type;
    state.digest = sha256(JSON.stringify(event.message));
  };
  const closed = (event) => { state.closed++; state.accepted = event.result; };
  session.on('Page.javascriptDialogOpening', opening);
  session.on('Page.javascriptDialogClosed', closed);
  try {
    await session.send('Page.enable');
    await popup.evaluate(async () => {
      const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
      window.__qaNativeDelete = { counter: 0, digest: '' };
      for (const row of document.querySelectorAll('[data-review-id]')) {
        const hash = await digest(row.dataset.reviewId);
        row.querySelector('[data-action="review-delete"]')?.addEventListener('click', (event) => {
          if (event.isTrusted) { window.__qaNativeDelete.counter++; window.__qaNativeDelete.digest = hash; }
        }, { capture: true, once: true });
      }
    });
  } catch (error) {
    await session.detach();
    throw error;
  }
  let sealed = false;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    session.off('Page.javascriptDialogOpening', opening);
    session.off('Page.javascriptDialogClosed', closed);
    await session.detach();
  };
  return {
    seal: async () => {
      if (sealed) return;
      if (!evidence || popup.isClosed() || JSON.stringify(state) !== evidence.events) throw new Error('native history dialog pre-acknowledgement evidence unavailable');
      await release();
      sealed = true;
    },
    passed: async ({ afterAcknowledgement = false } = {}) => {
      if (state.opening > 1 || state.closed > 1 || state.closed > state.opening) throw new Error('native history dialog event sequence invalid');
      if (afterAcknowledgement) {
        // A snapshot can only originate from the complete, freshly validated
        // native event + trusted click below, while the exact target is alive.
        // Late/mutated events cannot rehabilitate invalid or missing evidence.
        return sealed && evidence !== undefined && JSON.stringify(state) === evidence.events;
      }
      if (popup.isClosed()) throw new Error('native history dialog popup changed');
      if (state.opening === 0 || state.closed === 0) return false;
      if (state.type !== 'confirm' || state.digest !== messageDigest || state.accepted !== accepted) throw new Error('native history dialog confirmation mismatch');
      const click = await popup.evaluate(() => window.__qaNativeDelete);
      if (click?.counter !== 1 || click.digest !== targetDigest) throw new Error('native history dialog clicked record mismatch');
      evidence ??= Object.freeze({ events: JSON.stringify(state), targetDigest, messageDigest, accepted });
      return true;
    },
    close: release,
  };
}

// Separate disposable profile: synthetic records are never mixed into human
// consent/CRUD provenance. Load the SAME extracted candidate, without rebuilding.
function canonicalSnapshot(value) {
  const ordered = item => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item;
  return JSON.stringify(ordered(value));
}

export async function runSyntheticEvidence(candidate, template, { instruct, acknowledge, headless = false, selectPolicy } = {}) {
  let profile;
  let context;
  let popup;
  return runWithCleanup(async () => {
    instruct('34. SYNTHETIC EVIDENCE ONLY: a separate disposable profile loads the exact reviewed artifact. Fake 40-day-old/fresh observations and confirmed subscriptions are seeded through genuine storage APIs. This is NOT elapsed-time or organic provider history, consent, or positive provider browser navigation. Main human profile remains untouched.');
    profile = await mkdtemp(resolve(tmpdir(), 'clearchoice-synthetic-evidence-'));
    const launch = reviewBrowserLaunchOptions(candidate.extensionPath);
    context = await chromium.launchPersistentContext(profile, { ...launch, headless,
      args: [...launch.args, ...(!headless ? ['--ozone-platform=x11'] : [])] });
    await installReviewedExtension(context, candidate.extensionPath);
    const worker = await waitForReviewedExtensionWorker(context, candidate.extensionPath);
    popup = await syntheticNativePopup(context, worker, { headless });
    await waitForObservation(() => popup.evaluate(() => document.querySelector('[data-review-retention]')?.disabled === false));
    instruct('Synthetic candidate worker ready.');
    const validate = await storageValidatorSource();
    const origins = ['https://checkout-a.test:123', 'https://netflix.com', 'https://spotify.com', 'https://catalog-fallback.test'];
    const history = origins.map((origin, index) => {
      const timestamp = new Date(Date.now() - (index === 0 ? 40 : 1) * 86400000).toISOString();
      return { kind: template.kind, reason: template.reason, screenedExcerpt: template.screenedExcerpt,
        opaqueFingerprint: template.opaqueFingerprint, ordinal: 1, origin,
        id: 'f_' + sha256(JSON.stringify([origin, template.opaqueFingerprint, 1])),
        firstSeen: timestamp, latestSeen: timestamp, status: 'reviewed' };
    });
    const subscriptions = history.map((item, index) => ({ id: `s_synthetic_${index}`, merchant: `QA Synthetic ${index}`,
      amount: '12.00', currency: 'USD', cadence: 'monthly', createdAt: item.firstSeen, updatedAt: item.latestSeen, sourceFindingId: item.id }));
    const fixture = { version: 1, dismissed: false, reviewHistory: history, subscriptions, retentionPolicy: 'never', receipts: [], grantState: { version: 1, sites: {} } };
    const seed = await worker.evaluate(`(async value => { const validate = ${validate}; const canonical = ${canonicalSnapshot.toString()}; validate(await chrome.storage.local.get(null)); validate(value); await chrome.storage.local.set(value); return canonical(await chrome.storage.local.get(null)) === canonical(value); })(${JSON.stringify(fixture)})`);
    if (!seed) throw new Error('synthetic fixture seed readback mismatch');
    await (await popup.locator('[data-action="review-refresh"]').all())[0].click();
    await (await popup.locator('[data-subscription-action="refresh"]').all())[0].click();
    await waitForObservation(async () => await popup.locator('[data-review-id]').count() === 4);
    if (await popup.locator('[data-review-id]').count() !== 4) throw new Error('synthetic Never baseline mismatch');
    instruct('35. SYNTHETIC EXPIRY: in this separate visible extension page human-select 7 days in Keep local observations. Four observations must become three, while ALL four subscriptions survive. This page is not a toolbar consent checkpoint.');
    if (selectPolicy) await selectPolicy(popup); // Test-only injected callback; CLI never supplies it.
    const expected = { ...fixture, reviewHistory: history.slice(1), retentionPolicy: 7 };
    const read = async () => worker.evaluate(`(async expected => { const canonical = ${canonicalSnapshot.toString()}; const stored = await chrome.storage.local.get(null); (${validate})(stored); return canonical(stored) === canonical(expected); })(${JSON.stringify(expected)})`);
    await waitForObservation(async () => await read() && await popup.locator('[data-review-id]').count() === 3);
    if (await acknowledge('SYNTHETIC_EXPIRY_REVIEWED') !== 'SYNTHETIC_EXPIRY_REVIEWED') throw new Error('synthetic expiry acknowledgement missing');
    if (!await read()) throw new Error('synthetic expiry changed during acknowledgement');
    // Terminal/public-browser focus may destroy native action popups. Reacquire
    // the genuine target; this is disclosed synthetic UI evidence only.
    const reopen = async () => {
      await popup.close();
      popup = await syntheticNativePopup(context, worker, { headless });
      await waitForObservation(async () => await popup.locator('[data-subscription-list] > article').count() === 4);
    };
    await reopen();
    // Programmatic help-button activation is explicitly catalog/UI integration,
    // not a human provider action. Never activate any resulting anchor.
    const revealHelp = async () => {
      for (const button of await popup.locator('[data-subscription-action="help"]').all()) await button.click();
    };
    await revealHelp();
    const thirdParty = 'If billed through a third party, cancellation may need to be handled by that billing provider.';
    const expectedGuides = [
      { href: 'https://help.netflix.com/en/node/407', label: 'Official guide (reviewed 2026-09-29)', detail: `How to cancel Netflix. ${thirdParty}` },
      { href: 'https://support.spotify.com/us/article/cancel-premium/', label: 'Official guide (reviewed 2026-09-29)', detail: `How to cancel Premium plans. ${thirdParty} Leaving a Family or Duo plan as a member does not cancel the plan; contact the plan manager.` },
      { href: 'https://catalog-fallback.test/', label: 'Visit site — not a cancellation guide', detail: '' },
    ];
    const catalog = async () => popup.evaluate((guides) => {
      const allRows = Array.from(document.querySelectorAll('[data-subscription-list] > article'));
      const rows = [0, 1, 2, 3].map(index => allRows.find(row => row.querySelector('[data-subscription-action="help"]')?.getAttribute('aria-label') === `Cancellation help for QA Synthetic ${index}`));
      if (allRows.length !== 4 || rows.some(row => !row)) return false;
      if (rows.length !== 4 || rows[0].querySelector('a') || rows[0].querySelector('[role="status"]')?.textContent !== 'No known provider site; check your billing provider') return false;
      return guides.every((guide, index) => {
        const region = rows[index + 1].querySelector('[role="status"]');
        const links = region?.querySelectorAll('a');
        return links?.length === 1 && links[0].href === guide.href && links[0].textContent === guide.label
          && links[0].target === '_blank' && links[0].rel === 'noopener noreferrer'
          && (region.querySelector('p')?.textContent ?? '') === guide.detail;
      });
    }, expectedGuides);
    await waitForObservation(catalog);
    instruct('36. PUBLIC ARTICLES + ACTUAL BUNDLED CATALOG: inspect the three rendered help links, literal reviewed date 2026-09-29, titles, third-party billing and Spotify Family/Duo caveats. Do NOT click these links. Separately, in your own browser outside the restricted runner, read ONLY https://help.netflix.com/en/node/407 and https://support.spotify.com/us/article/cancel-premium/ (official public help articles, not accounts). Compare current instructions/caveats with this actual candidate catalog. If content is unavailable or mismatches, abort and report it. This acceptance is NOT positive provider browser navigation, billing provenance or cancellation.');
    if (await acknowledge('PUBLIC_GUIDES_AND_CATALOG_REVIEWED') !== 'PUBLIC_GUIDES_AND_CATALOG_REVIEWED') throw new Error('public guides and catalog acknowledgement missing');
    await reopen();
    await revealHelp();
    await waitForObservation(catalog);
    if (!await catalog() || !await read()) throw new Error('synthetic catalog or storage changed during acknowledgement');
    return { expiry: true, catalog: true, publicReview: true };
  }, [() => popup?.close(), () => context?.close(), () => profile && rm(profile, { recursive: true, force: true })]);
}

export async function attestCompletedWorkflow(candidate, results, { instruct, acknowledge, recheck, emit }) {
  // Validate completeness BEFORE offering ATTEST. No default passing predicates.
  createManualActiveTabQaMarker(candidate, results);
  await recheck();
  instruct('37. Final local human self-attestation: all real toolbar/Chrome/keyboard/CRUD actions plus the explicitly mixed synthetic-expiry and public-article/bundled-catalog evidence are complete. NOT positive provider browser navigation. Type ATTEST only if accurate; anything else aborts.');
  if (await acknowledge() !== 'ATTEST') throw new Error('final human attestation missing; marker was not emitted');
  await recheck();
  emit(JSON.stringify(createManualActiveTabQaMarker(candidate, results), null, 2) + '\n');
}

export function createManualActiveTabQaMarker({ commit, manifestSha256, archiveSha256 }, results) {
  if (!results || Object.getPrototypeOf(results) !== Object.prototype
      || Reflect.ownKeys(results).length !== WORKFLOW_PREDICATES.length + 1
      || [...WORKFLOW_PREDICATES, 'reenableEvidence'].some((field) => !Object.hasOwn(results, field))) {
    throw new Error('complete validated workflow results are required; marker was not emitted');
  }
  const marker = { schemaVersion: 7, ...MIXED_EVIDENCE, outcome: 'passed', ...results,
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

export async function runManualActiveTabQa(argv = process.argv.slice(2), { prepare = prepareCandidateArchive, review = reviewCandidate, log = createQaRunLog() } = {}) {
  let failure;
  let failed = false;
  let cancelled = false;
  const onCancel = () => { cancelled = true; };
  process.on('SIGINT', onCancel);
  try {
    parseArguments(argv);
    const candidate = prepare(root);
    log.record('binding', { binding: { commit: candidate.commit, manifestSha256: candidate.manifestSha256, archiveSha256: candidate.archiveSha256 } });
    await runWithCleanup(() => review(candidate, { log }), [() => candidate.cleanup()]);
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    process.off('SIGINT', onCancel);
    try { log.finish(failure, { failed, interrupted: cancelled }); } catch { /* diagnostics cannot replace the QA outcome */ }
  }
}

export async function observeQaSnapshot(page, context, expectedOrigin, classifier) {
    // Never enumerate unrelated tabs or attach a native popup for diagnostics.
    if (!page || page.isClosed() || page.context() !== context || !classifier) return { route: 'unknown' };
    if (!/^https:\/\/checkout-[ab]\.test:[1-9]\d{0,4}$/.test(expectedOrigin ?? '') || new URL(expectedOrigin).port > 65535 || new URL(page.url()).origin !== expectedOrigin) return { route: 'unknown' };
    let timeout;
    try {
      return await Promise.race([
        page.evaluate(`(() => { if (location.origin !== ${JSON.stringify(expectedOrigin)}) return { route: 'unknown' };
          const routes = { '/checkout/clean': 'clean', '/checkout/dynamic-beta': 'dynamic', '/checkout/identical': 'identical', '/information': 'information' };
          const route = routes[location.pathname]; if (!route) return { route: 'unknown' };
          ${classifier}
          const geometry = (${observeMockPanelGeometry.toString()})();
          const predicates = window.__clearchoiceManualIntegrityBaseline?.predicates;
          const integrity = Object.fromEntries(['integrity', 'href', 'forms', 'controlIdentity', 'controlValues', 'controlChecked', 'controlDisabled', 'hostNodes'].map(key => [key, predicates?.[key] === true]));
          return { route, site: location.hostname === 'checkout-a.test' ? 'a' : 'b', supported: QaContext.classifyCheckoutContext(document.body) === 'supported', panelCount: document.querySelectorAll('aside[data-clearchoice-panel]').length,
            findingCount: Array.from(document.querySelectorAll('aside[data-clearchoice-panel]')).reduce((count, panel) => count + (panel.shadowRoot ?? panel).querySelectorAll('article').length, 0), ...geometry, ...integrity };
        })()`),
        new Promise(resolveSnapshot => { timeout = setTimeout(() => resolveSnapshot({ route: 'unknown' }), 2_000); }),
      ]);
    } catch { return { route: 'unknown' }; }
    finally { clearTimeout(timeout); }
}

export async function observeQaWorkerCounts(worker, origin, targetUrl) {
  if (!worker || !/^https:\/\/checkout-[ab]\.test:[1-9]\d{0,4}$/.test(origin ?? '') || new URL(origin).port > 65535) return {};
  try {
    if (new URL(targetUrl).origin !== origin) return {};
    return await worker.evaluate(async ({ origin, targetUrl }) => {
      const [stored, sitePermission, scripts, tabs] = await Promise.all([
        chrome.storage.local.get(['reviewHistory', 'subscriptions', 'grantState']),
        chrome.permissions.contains({ origins: [origin + '/*'] }),
        chrome.scripting.getRegisteredContentScripts(), chrome.tabs.query({}),
      ]);
      // Only an exact controlled mock tab is queried for its badge, never popup UI.
      const tab = tabs.find(item => item.url === targetUrl);
      const badge = tab ? await chrome.action.getBadgeText({ tabId: tab.id }) : null;
      return { historyCount: Math.min(10000, Array.isArray(stored.reviewHistory) ? stored.reviewHistory.length : 0),
        subscriptionCount: Math.min(10000, Array.isArray(stored.subscriptions) ? stored.subscriptions.length : 0),
        hasGrant: stored.grantState?.sites?.[origin]?.enabled === true, sitePermission: sitePermission === true,
        registered: scripts.some(item => item.matches?.includes(origin + '/*')),
        ...(badge === '' ? { badgeCount: 0 } : typeof badge === 'string' && /^\d{1,4}$/.test(badge) ? { badgeCount: Number(badge) } : {}) };
    }, { origin, targetUrl });
  } catch { return {}; }
}

export async function reviewCandidate(candidate, {
  createTls = createFixtureTls, makeServer = createServer, createProfile = mkdtemp,
  launchContext = (...args) => chromium.launchPersistentContext(...args), removeProfile = rm,
  install = installReviewedExtension, log = { path: null, record: () => false },
} = {}) {
  const { extensionPath } = candidate;
  let tls;
  let server;
  let profile;
  let context;
  let terminal;
  let diagnosticPage;
  let diagnosticOrigin;
  let classifier;
  let heartbeat;
  let sampling = false;
  let progressAt = Date.now();
  let lastSnapshot;
  let diagnosticWorker;
  let diagnosticStage = 'setup';
  const mismatch = createQaMismatchMonitor(log);
  let lastObserved;
  const waitForState = observe => waitForObservation(async () => {
    const passed = await observe();
    if (typeof passed === 'boolean' && passed !== lastObserved) {
      if (lastObserved === true && passed === false) log.record('issue', { checkpoint: diagnosticStage, errorCode: 'observed_state_changed', snapshot: { observed: false, actionObserved: true } });
      lastObserved = passed;
      log.record('observation', { snapshot: { observed: passed } });
    }
    return passed;
  });
  const interrupt = new AbortController();
  const onInterrupt = () => { interrupt.abort(); context?.close().catch(() => {}); };
  const instruct = text => {
    const checkpoint = checkpointId(text);
    if (checkpoint) { diagnosticStage = checkpoint; mismatch.stage(checkpoint); lastObserved = undefined; progressAt = Date.now(); log.record('checkpoint', { checkpoint }); }
    process.stdout.write(`${text}\n`);
  };
  const snapshot = () => observeQaSnapshot(diagnosticPage, context, diagnosticOrigin, classifier);
  await runWithCleanup(async () => {
    process.on('SIGINT', onInterrupt);
    heartbeat = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      const stage = diagnosticStage;
      try {
        const observed = await snapshot();
        if (observed.route !== 'unknown' && diagnosticWorker) {
          Object.assign(observed, await observeQaWorkerCounts(diagnosticWorker, diagnosticOrigin, diagnosticPage.url()));
          observed.expectedHasGrant = observed.site === 'a' && ['14', '15a', '15b', '15c', '15d', '15e', '15f', '15g', '16', '17a', '17b'].includes(stage);
        }
        if (stage !== diagnosticStage || interrupt.signal.aborted) return;
        mismatch.sample(observed);
        const serialized = JSON.stringify(observed);
        if (serialized !== lastSnapshot) { lastSnapshot = serialized; log.record('observation', { snapshot: observed }); }
        if (Date.now() - progressAt >= 30000) { progressAt = Date.now(); log.record('stall', { snapshot: observed }); }
      } finally { sampling = false; }
    }, 1000);
    heartbeat.unref();
    try {
    const { build } = await import('esbuild');
    classifier = (await build({ entryPoints: [resolve(root, 'src/core/context.ts')], bundle: true, write: false, format: 'iife', globalName: 'QaContext' })).outputFiles[0].text;
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
    diagnosticWorker = worker;
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
    process.stdout.write('The runner retains only SHA-256 integrity digests, panel/integrity pass-fail predicates and passive mock panel viewport/element bounds; it never writes or prints page text or records.\n\n');
    terminal = createInterface({ input: process.stdin, output: process.stdout });
    if (log.path) process.stdout.write(`Local diagnostic JSON (not a marker): ${log.path}\n`);
    const question = terminal.question.bind(terminal);
    terminal.question = async (prompt, options = {}) => {
      const token = acknowledgementToken(prompt);
      log.record('ack_wait', token ? { token } : {});
      const answer = await question(prompt, { ...options, signal: options.signal ? AbortSignal.any([options.signal, interrupt.signal]) : interrupt.signal });
      log.record('ack', { ...(token ? { token } : {}), snapshot: { acknowledged: token ? answer === token : answer === 'ATTEST' } });
      progressAt = Date.now();
      return answer; // Never retain the human's raw input.
    };
    diagnosticPage = cleanPage;
    diagnosticOrigin = fixtureOrigin;
    let dynamicPage;
    const results = {};
    await runManualCheckpoints({
      cleanPage,
      getDynamicPage: () => dynamicPage,
      instruct,
      waitForPanel,
      assertIntegrity,
      confirmCleanAnalyze: async () => {
        // Observe the genuine popup outcome; a quiet page alone cannot prove Analyze.
        await waitForNativePopup(context, new URL('/popup/index.html', worker.url()).href,
          () => document.querySelector('main > p[role="status"]')?.textContent === 'No matching signals found on this page.');
        // The outcome was observed before requesting acknowledgement. Moving to
        // the terminal may close the native popup; zero-state readback follows.
        if (await terminal.question('Observed real popup: No matching signals found on this page. Type DONE to acknowledge (terminal focus may close the popup): ', { signal: AbortSignal.timeout(300_000) }) !== 'DONE') throw new Error('clean Analyze not acknowledged');
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
        diagnosticPage = dynamicPage;
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
    results.cleanFixtureIntegrity = 'passed';
    results.dynamicFixtureIntegrity = 'passed';
    if (await terminal.question('Type KEYBOARD_AND_POINTER_REVIEWED only after visible Tab focus, Escape, pointer Dismiss and both pointer Restore actions were actually verified: ', { signal: AbortSignal.timeout(300_000) }) !== 'KEYBOARD_AND_POINTER_REVIEWED') throw new Error('accessibility acknowledgement missing');
    results.accessibility = true;
    const pages = { a: dynamicPage };
    const origins = { a: fixtureOrigin, b: fixtureOrigin.replace('checkout-a.test', 'checkout-b.test') };
    const popupUrl = new URL('/popup/index.html', worker.url()).href;
    const validateStorage = await storageValidatorSource();
    const siteRead = async (mode, site) => {
      if (new URL(pages[site].url()).origin !== origins[site]) throw new Error('mock page origin changed');
      const observe = async () => (await worker.evaluate(`(${observeSiteState.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(origins[site])}, globalThis, ${validateStorage})`)).passed;
      if (['baseline', 'before-revoke'].includes(mode)) return observe();
      await waitForState(observe);
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
      instruct,
      acknowledge: (token = 'DONE') => terminal.question(`Type ${token} only after the requested real human action and observation (anything else aborts): `, { signal: AbortSignal.timeout(300_000) }),
      navigate: async (site, positive) => {
        pages[site] ??= await context.newPage();
        diagnosticPage = pages[site];
        diagnosticOrigin = origins[site];
        await pages[site].goto(`${origins[site]}/checkout/${positive ? 'dynamic-beta#checkout' : 'clean'}`);
        await captureIntegrityBaseline(pages[site]);
        await pages[site].bringToFront();
      },
      lifecycle: () => runAutomaticLifecycleCheckpoints({
        instruct, waitForState,
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
        navigate: async () => { diagnosticPage = pages.a; diagnosticOrigin = origins.a; await pages.a.goto(`${origins.a}/checkout/identical`); await captureIntegrityBaseline(pages.a, true); },
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
      denied: () => armHumanDenial({ context, worker, popupUrl, origin: origins.b,
        instruct }),
      integrity: (site) => assertIntegrity(pages[site], 'site permission checkpoint'),
      mutate: async () => {
        await pages.a.waitForFunction(() => document.querySelector('#fake-order-summary')?.textContent?.includes('updated') === true, undefined, { timeout: 300_000 });
      },
    });
    results.optInConsent = 'passed';
    results.optInDenial = 'passed';
    results.siteIsolation = 'passed';
    results.automaticLifecycle = 'passed';
    const permissionCycle = await runPermissionCycleCheckpoints({
      instruct, waitForState,
      acknowledge: (token) => terminal.question(`Type ${token} only after the specified real human action (anything else aborts): `, { signal: AbortSignal.timeout(300_000) }),
      read: async (mode) => {
        const observe = async () => (await worker.evaluate(`(${observePermissionCycle.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(origins.a)}, globalThis, ${validateStorage}, (${observeSiteState.toString()}))`)).passed;
        if (!await observe()) return false;
        if (mode === 'settings-removed') {
          for (let sample = 0; sample < 5; sample++) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 200));
            if (!await observe()) return false;
          }
        }
        return true;
      },
      ui: async (mode, { afterAcknowledgement = false } = {}) => {
        const panel = pages.a.locator('aside[data-clearchoice-panel]');
        if (mode === 'quiet') return await panel.count() === 0;
        const pageVisible = await panel.count() === 1 && await panel.locator('article').count() === 1;
        if (!pageVisible) return false;
        // The exact enabled popup status was observed before acknowledgement.
        // Terminal focus may destroy it; recheck the page and full durable
        // permission/grant/storage/badge state, never reopen or pin that popup.
        if (afterAcknowledgement) return true;
        return await readNativePopup(context, popupUrl,
          expected => document.querySelector('[data-site-status]')?.textContent === expected,
          `Detection enabled for ${origins.a}; supported English checkout detection is enabled, not a completed scan.`);
      },
      integrity: () => assertIntegrity(pages.a, 'human reenable/Chrome Settings removal'),
    });
    results.reenableEvidence = permissionCycle.reenableEvidence;
    results.revocation = 'passed';
    const expectedWorkerUrl = await reviewedWorkerUrl(extensionPath);
    const bindLaterTab = () => worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) throw new Error('later checkpoint active tab unavailable');
      return tabs[0].id;
    });
    let laterTabId = await bindLaterTab();
    const laterIntegrity = async (checkpoint) => {
      await assertIntegrity(pages.a, checkpoint);
      await recheckCandidateBinding(root, candidate);
      const valid = await worker.evaluate(async ({ origin, expectedWorkerUrl, tabId }) => {
        const [permissions, scripts, stored, tabs] = await Promise.all([
          chrome.permissions.getAll(), chrome.scripting.getRegisteredContentScripts(), chrome.storage.local.get('grantState'),
          chrome.tabs.query({ active: true, currentWindow: true }),
        ]);
        const grant = stored.grantState?.sites?.[origin];
        return tabs.length === 1 && tabs[0].id === tabId
          && (tabs[0].url === undefined || new URL(tabs[0].url).origin === origin)
          && chrome.runtime.getURL('worker.js') === expectedWorkerUrl
          && chrome.runtime.id === new URL(expectedWorkerUrl).hostname
          && Array.isArray(permissions.origins) && permissions.origins.length === 0
          && scripts.length === 0 && !await chrome.permissions.contains({ origins: [origin + '/*'] })
          && grant?.enabled === false && grant.generation > 0;
      }, { origin: origins.a, expectedWorkerUrl, tabId: laterTabId });
      if (!valid) throw new Error('later checkpoint worker identity or revoked browser state changed');
    };
    let targetDigest;
    let deleteDigest;
    let dialogDigest;
    await runHistorySubscriptionCheckpoints({
      waitForState,
      prepareNativePopup: async () => {
        process.stdout.write('Native history checkpoint: human-open the toolbar popup if closed; do not click Delete until the numbered instruction appears.\n');
        await waitForNativePopup(context, popupUrl, () => true);
      },
      nativeDialog: async (accepted) => {
        return observeNativeHistoryDialog(context, await passiveNativePopup(context, popupUrl), deleteDigest, dialogDigest, accepted);
      },
      instruct,
      acknowledge: (instruction) => terminal.question(`Type DONE to acknowledge the observed stage ${instruction.slice(0, instruction.indexOf('.'))} human action/result (each stage needs its own DONE): `, { signal: AbortSignal.timeout(300_000) }),
      read: async (mode) => {
        const result = await worker.evaluate(`(${observeHistorySubscriptions.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(origins.a)}, globalThis, ${validateStorage})`);
        if (mode === 'baseline') targetDigest = result.targetDigest;
        if (mode === 'history-delete-baseline') { deleteDigest = result.deleteDigest; dialogDigest = result.dialogDigest; }
        return result.passed;
      },
      ui: async (mode, options) => {
        return readNativePopup(context, popupUrl, `(${observeHistorySubscriptionUi.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(targetDigest)}, ${JSON.stringify(deleteDigest)})`, undefined, options);
      },
      integrity: () => laterIntegrity('history/subscription checkpoint'),
    });
    results.reviewHistory = 'passed';
    results.subscriptions = 'passed';
    let finalBaseline;
    const readFinal = async (mode) => worker.evaluate(`(${observeFinalState.toString()})(chrome, ${JSON.stringify(mode)}, ${JSON.stringify(origins.a)}, ${JSON.stringify(expectedWorkerUrl)}, ${JSON.stringify(finalBaseline)}, ${validateStorage})`);
    const uiFinal = async (mode) => {
      return readNativePopup(context, popupUrl, `(${observeFinalUi.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(origins.a)})`);
    };
    await runFinalCheckpoints({
      instruct, waitForState,
      acknowledge: () => terminal.question('Type DONE after the requested human action/observation: ', { signal: AbortSignal.timeout(300_000) }),
      read: async (mode) => {
        if (mode === 'baseline') { finalBaseline = await readFinal(mode); return true; }
        const passed = await readFinal(mode);
        if (passed && mode === 'retention') finalBaseline = { ...finalBaseline, policy: 7 };
        return passed;
      },
      ui: uiFinal,
      integrity: () => laterIntegrity('final checkpoint'),
      restart: async () => {
        await context.close();
        context = await launchContext(profile, reviewBrowserLaunchOptions(extensionPath, tls.pin));
        // Same profile, no extension reinstall, same servers and pinned certificate.
        pages.a = await context.newPage();
        diagnosticPage = pages.a;
        diagnosticOrigin = origins.a;
        await pages.a.goto(`${origins.a}/checkout/dynamic-beta#checkout`);
        await captureIntegrityBaseline(pages.a);
        await pages.a.bringToFront();
        await wakeReviewedExtension(context, extensionPath);
        worker = await waitForReviewedExtensionWorker(context, extensionPath);
        diagnosticWorker = worker;
        laterTabId = await bindLaterTab();
      },
      quiet: async () => await pages.a.locator('aside[data-clearchoice-panel]').count() === 0,
    });
    // Only screened fake fixture evidence crosses into the separate test profile;
    // no records are printed, written to evidence files, or included in the marker.
    const template = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get(null);
      const source = stored.reviewHistory.find(item => item.id === stored.subscriptions[0].sourceFindingId);
      return { kind: source.kind, reason: source.reason, screenedExcerpt: source.screenedExcerpt, opaqueFingerprint: source.opaqueFingerprint };
    });
    const mixed = await runSyntheticEvidence(candidate, template, {
      instruct,
      acknowledge: token => terminal.question(`Type ${token} only after the explicitly labeled review: `, { signal: AbortSignal.timeout(300_000) }),
    });
    if (mixed.expiry !== true || mixed.catalog !== true || mixed.publicReview !== true) throw new Error('mixed evidence acceptance incomplete');
    if (!await readFinal('unchanged')) throw new Error('primary human profile changed during separate synthetic review');
    results.retention = 'passed';
    results.cancellationHelp = 'passed';
    await attestCompletedWorkflow(candidate, results, {
      instruct,
      acknowledge: () => terminal.question('Final acknowledgement: ', { signal: AbortSignal.timeout(300_000) }),
      recheck: () => recheckCandidateBinding(root, candidate),
      emit: text => process.stdout.write(text),
    });
    process.stdout.write('Save ONLY the emitted JSON outside this repository and supply its path in CLEARCHOICE_ACTIVE_TAB_QA_MARKER to npm run check:beta. Do not rebuild or repackage after attestation.\n');
    } catch (error) {
      try { log.record('observation', { snapshot: await snapshot() }); } catch { /* preserve the primary QA failure */ }
      throw error;
    }
  }, [
    () => { clearInterval(heartbeat); process.off('SIGINT', onInterrupt); },
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
