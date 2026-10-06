/* global chrome, document, location, crypto, TextEncoder, setTimeout, performance */
import { randomBytes } from 'node:crypto';
import { passiveNativePopup } from './passive-native-popup.mjs';
import { waitForObservation, runWithCleanup } from './manual-qa-stages.mjs';

// Runner-only instrumentation; forwards the real API synchronously and never
// observes/answers the permission result. The receiver outlives the popup.
export async function installDenialReceiver(api, host, expected) {
  if (host.__qaDenial) throw new Error('denial receiver already armed');
  const canonical = value => JSON.stringify(value, function (_key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
  const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))), byte => byte.toString(16).padStart(2, '0')).join('');
  const isolation = async () => digest({ storage: await api.storage.local.get(null),
    permissions: await api.permissions.getAll(), scripts: await api.scripting.getRegisteredContentScripts() });
  const baseline = await isolation();
  const state = { count: 0, valid: false, ready: false, detachedAfter: null, invalidated: false, started: performance.now(), expected };
  const listener = (message, sender) => {
    if (message?.type !== 'QA_PERMISSION_REQUEST_INVOKED') return;
    state.count++;
    state.valid = state.ready && state.count === 1 && sender.url === expected.popupUrl
      && sender.id === api.runtime.id && sender.tab === undefined
      && Object.keys(message).sort().join(',') === 'invokedAt,nonce,origin,tabId,trusted,type'
      && message.nonce === expected.nonce && message.origin === expected.origin
      && message.tabId === expected.tabId && message.trusted === true
      && Number.isFinite(state.detachedAfter) && Number.isFinite(message.invokedAt)
      && message.invokedAt > state.detachedAfter
      && message.invokedAt - state.detachedAfter <= expected.timeoutMs
      && performance.now() >= state.started && performance.now() - state.started <= expected.timeoutMs;
  };
  api.runtime.onMessage.addListener(listener);
  const activated = ({ tabId }) => { if (tabId !== expected.tabId) state.invalidated = true; };
  const updated = (tabId, change) => { if (tabId === expected.tabId && (change.url !== undefined || change.status === 'loading')) state.invalidated = true; };
  api.tabs.onActivated.addListener(activated);
  api.tabs.onUpdated.addListener(updated);
  const isolated = async () => {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs.length === 1 && tabs[0].id === expected.tabId
      && (tabs[0].url === undefined || new URL(tabs[0].url).origin === expected.origin)
      && await isolation() === baseline;
  };
  host.__qaDenial = { state, listener, activated, updated, isolated };
}

export async function instrumentDenialPopup(expected) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const button = document.querySelector('[data-action="site-enable"]');
  if (location.href !== expected.popupUrl || await chrome.tabs.getCurrent() !== undefined
    || tabs.length !== 1 || tabs[0].id !== expected.tabId
    || new URL(tabs[0].url).origin !== expected.origin || !button || button.disabled
    || document.querySelector('[data-site-status]')?.textContent !== `Detection off for ${expected.origin}.`
    || globalThis.__qaDenialInstalled) return false;
  globalThis.__qaDenialInstalled = true;
  let trusted = false;
  button.addEventListener('click', event => {
    trusted = event.isTrusted && !button.disabled;
    setTimeout(() => { trusted = false; }, 0); // Cannot reuse the click in a later task.
  }, { capture: true });
  const original = chrome.permissions.request;
  chrome.permissions.request = function (...args) {
    // No await, mock, callback substitution or result transformation.
    const invokedAt = performance.now();
    const result = Reflect.apply(original, this, args);
    const request = args[0];
    const exact = args.length === 1 && request && Object.keys(request).join(',') === 'origins'
      && Array.isArray(request.origins) && request.origins.length === 1
      && request.origins[0] === expected.origin + '/*';
    try {
      void chrome.runtime.sendMessage({ type: 'QA_PERMISSION_REQUEST_INVOKED', nonce: expected.nonce,
        origin: exact ? expected.origin : '', tabId: expected.tabId, trusted, invokedAt }).catch(() => {});
    } catch { /* Lost witness fails the runner closed, never changes the real API result. */ }
    trusted = false;
    return result;
  };
  return { sampledAt: performance.now() };
}

// Both clocks are steady elapsed clocks (not wall epochs). Starting the host
// interval BEFORE popup evaluation and ending AFTER confirmed detach overbounds
// the popup's sample-to-detach interval. Add a millisecond for clock rounding;
// ambiguous boundary clicks fail closed. No popup attachment is needed afterward.
export function denialDetachmentCutoff(sampledAt, hostBefore, hostAfter) {
  if (![sampledAt, hostBefore, hostAfter].every(Number.isFinite)
    || sampledAt < 0 || hostBefore < 0 || hostAfter < hostBefore) throw new Error('invalid denial clock calibration');
  return sampledAt + Math.ceil(hostAfter - hostBefore) + 1;
}

export function denialRequestPassed(state, expected, now = performance.now()) {
  return !!state && state.count === 1 && state.valid === true && state.invalidated === false
    && state.expected.nonce === expected.nonce && state.expected.origin === expected.origin
    && state.expected.tabId === expected.tabId && state.expected.popupUrl === expected.popupUrl
    && now >= state.started && now - state.started <= expected.timeoutMs;
}

export async function armHumanDenial({ context, worker, popupUrl, origin, instruct, timeoutMs = 300_000 }) {
  if (!/^https:\/\/checkout-b\.test:[1-9]\d{0,4}$/.test(origin) || Number(new URL(origin).port) > 65535) throw new Error('invalid B denial origin');
  const tabId = await worker.evaluate(() => globalThis.__qaTabId);
  if (!Number.isInteger(tabId)) throw new Error('denial tab baseline unavailable');
  const expected = { popupUrl, origin, tabId, nonce: randomBytes(16).toString('hex'), timeoutMs };
  const close = () => worker.evaluate(() => {
    if (globalThis.__qaDenial) {
      chrome.runtime.onMessage.removeListener(globalThis.__qaDenial.listener);
      chrome.tabs.onActivated.removeListener(globalThis.__qaDenial.activated);
      chrome.tabs.onUpdated.removeListener(globalThis.__qaDenial.updated);
    }
    delete globalThis.__qaDenial;
  });
  await worker.evaluate(`(${installDenialReceiver.toString()})(chrome, globalThis, ${JSON.stringify(expected)})`);
  try {
    instruct('15 PREPARE: human-open the B toolbar popup. Do NOT click Enable until the B DENIAL instruction appears. The runner will detach its popup observer before the real request.');
    let detachedAfter;
    await waitForObservation(async () => {
      const popup = await passiveNativePopup(context, popupUrl);
      if (!popup) return false;
      const before = performance.now();
      const sample = await runWithCleanup(() => popup.evaluate(instrumentDenialPopup, expected), [() => popup.close()]);
      if (!sample) return false;
      detachedAfter = denialDetachmentCutoff(sample.sampledAt, before, performance.now());
      return true;
    }, { timeoutMs });
    // No popup-target attachment survives this point or the permission modal.
    await worker.evaluate(cutoff => {
      globalThis.__qaDenial.state.detachedAfter = cutoff;
      globalThis.__qaDenial.state.ready = true;
    }, detachedAfter);
    const requested = async () => worker.evaluate(`(${denialRequestPassed.toString()})(globalThis.__qaDenial?.state, ${JSON.stringify(expected)})`);
    const passed = async () => worker.evaluate(`(async () => {
      const entry = globalThis.__qaDenial;
      const valid = () => (${denialRequestPassed.toString()})(entry?.state, ${JSON.stringify(expected)});
      return valid() && await entry.isolated() && valid();
    })()`);
    return { observed: () => waitForObservation(requested, { timeoutMs }), passed, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
