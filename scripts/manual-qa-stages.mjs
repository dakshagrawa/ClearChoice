/* global setTimeout, crypto, TextEncoder, document */
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Bundle only the production PURE validators, never call the mutating loader.
// This does not build/repackage the reviewed extension or write any files.
export async function storageValidatorSource() {
  const result = await build({ stdin: { contents: `export { isFindingHistory, isSubscriptionCollection, isRetentionPolicy } from './src/shared/models.ts'; export { isGrantState } from './src/shared/storage.ts';`, resolveDir: resolve(import.meta.dirname, '..') }, bundle: true, write: false, format: 'iife', globalName: 'QaSchemas', platform: 'browser' });
  return `(() => { ${result.outputFiles[0].text}; return (stored) => (${validateStorageReadback.toString()})(stored, QaSchemas); })()`;
}

export function validateStorageReadback(stored, schema) {
  const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const has = (key) => Object.hasOwn(stored, key);
  const keys = ['version', 'dismissed', 'subscriptions', 'reviewHistory', 'retentionPolicy', 'receipts', 'grantState'];
  const receipts = (value) => Array.isArray(value) && value.length <= 500
    && value.every((item) => record(item) && Object.keys(item).length === 3
      && ['requestId', 'digest', 'outcome'].every((key) => Object.hasOwn(item, key))
      && typeof item.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.requestId)
      && typeof item.digest === 'string' && /^[a-f0-9]{64}$/.test(item.digest)
      && record(item.outcome) && Object.keys(item.outcome).length === 1
      && Array.isArray(item.outcome.ids) && item.outcome.ids.length <= 100
      && item.outcome.ids.every((id) => typeof id === 'string' && /^f_[a-f0-9]{64}$/.test(id)))
    && new Set(value.map((item) => item.requestId)).size === value.length;
  if (!schema || !record(stored) || !Object.keys(stored).every((key) => keys.includes(key))
    || (has('version') && stored.version !== 1)
    || (has('dismissed') && typeof stored.dismissed !== 'boolean')
    || (has('subscriptions') && !schema.isSubscriptionCollection(stored.subscriptions))
    || (has('reviewHistory') && !schema.isFindingHistory(stored.reviewHistory))
    || (has('retentionPolicy') && !schema.isRetentionPolicy(stored.retentionPolicy))
    || (has('receipts') && !receipts(stored.receipts))
    || (has('grantState') && !schema.isGrantState(stored.grantState))
    || (has('version') ? !has('subscriptions') || !has('reviewHistory')
      : ['subscriptions', 'reviewHistory', 'retentionPolicy', 'receipts'].some(has))) {
    throw new Error('readback storage schema invalid');
  }
  return true;
}

// Enclose acquisition as well as work: every registered closer is attempted,
// and cleanup cannot replace the first operation failure (even a falsy throw).
export async function runWithCleanup(operation, steps) {
  let result;
  let failed = false;
  let firstFailure;
  try { result = await operation(); }
  catch (error) { failed = true; firstFailure = error; }
  for (const step of steps) {
    try { await step(); }
    catch (error) {
      if (!failed) { failed = true; firstFailure = error; }
    }
  }
  if (failed) throw firstFailure;
  return result;
}

// Observation callbacks must only read; gestures belong exclusively to the human.
export async function runHumanStage({ instruction, instruct, observe, acknowledge }) {
  instruct(instruction);
  if (await observe() !== true) throw new Error('human stage observable predicate failed');
  if (await acknowledge() !== 'DONE') throw new Error('human stage acknowledgement missing');
  return true;
}

export async function waitForObservation(observe, { timeoutMs = 300_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await observe() === true) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('human stage observation timed out; marker was not emitted');
}

// Serialized into the genuine worker. Raw mock records are transient; only hashes
// and generation numbers survive a call. No writes, messages or permission grants.
export async function observeSiteState(api, mode, origin, host = globalThis, validate) {
  if (!/^https:\/\/checkout-[ab]\.test:[1-9]\d{0,4}$/.test(origin) || new URL(origin).port > 65535) throw new Error('invalid mock origin');
  const stored = await api.storage.local.get(null);
  if (typeof validate !== 'function') throw new Error('readback storage validator unavailable');
  validate(stored);
  const history = stored.reviewHistory ?? [];
  const subscriptions = stored.subscriptions ?? [];
  const sites = stored.grantState?.sites ?? {};
  if (!Array.isArray(history) || !Array.isArray(subscriptions) || !sites || Array.isArray(sites)
    || typeof sites !== 'object') throw new Error('site storage unavailable');
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const historyDigest = await digest(history);
  const subscriptionsDigest = await digest(subscriptions);
  if (mode === 'baseline') {
    host.__qaHistoryDigest = historyDigest;
    host.__qaSubscriptionsDigest ??= subscriptionsDigest;
    host.__qaHistoryCount ??= history.length;
    const active = await api.tabs.query({ active: true, currentWindow: true });
    if (active.length !== 1 || !Number.isInteger(active[0].id)) throw new Error('site tab baseline unavailable');
    host.__qaTabId = active[0].id;
    return { passed: true, historyCount: history.length, subscriptionCount: subscriptions.length };
  }
  const permissions = await api.permissions.getAll();
  const scripts = await api.scripting.getRegisteredContentScripts();
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (mode === 'enabled' && tabs.length === 1 && Number.isInteger(tabs[0].id) && tabs[0].url === undefined) {
    // Await the genuine toolbar/permission gesture; missing activeTab is not success.
    return { passed: false, historyCount: history.length, subscriptionCount: subscriptions.length };
  }
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)
    || (tabs[0].url !== undefined && new URL(tabs[0].url).origin !== origin)
    || (tabs[0].url === undefined && (!['quiet', 'revoked'].includes(mode) || tabs[0].id !== host.__qaTabId))) throw new Error('site tab readback unavailable');
  if (!Array.isArray(permissions.origins) || !Array.isArray(scripts)) throw new Error('site browser readback unavailable');
  const pattern = origin + '/*';
  const permitted = await api.permissions.contains({ origins: [pattern] });
  const id = 'clearchoice-site-' + await digestOrigin(origin);
  async function digestOrigin(value) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const exactScripts = scripts.filter((script) => script.id === id || script.matches?.includes(pattern));
  const registered = exactScripts.length === 1 && exactScripts[0].id === id
    && exactScripts[0].matches?.length === 1 && exactScripts[0].matches[0] === pattern
    && exactScripts[0].js?.length === 1 && exactScripts[0].js[0] === 'content.js'
    && exactScripts[0].allFrames === false && exactScripts[0].persistAcrossSessions === true && exactScripts[0].world === 'ISOLATED';
  const grant = sites[origin];
  const enabled = permitted && permissions.origins.includes(pattern) && registered
    && grant?.enabled === true && Number.isSafeInteger(grant.generation) && grant.generation > 0;
  const badge = await api.action.getBadgeText({ tabId: tabs[0].id });
  const subscriptionsUnchanged = subscriptionsDigest === host.__qaSubscriptionsDigest;
  let passed = false;
  if (mode === 'enabled') passed = enabled && subscriptionsUnchanged && historyDigest === host.__qaHistoryDigest && badge === '';
  else if (mode === 'positive') passed = enabled && subscriptionsUnchanged && history.length >= host.__qaHistoryCount
    && historyDigest !== host.__qaHistoryDigest
    && history.some((item) => item.origin === origin && item.kind === 'recurring-charge') && badge === '1';
  else if (mode === 'quiet') passed = !permitted && !permissions.origins.includes(pattern) && !grant
    && exactScripts.length === 0 && !history.some((item) => item.origin === origin)
    && historyDigest === host.__qaHistoryDigest && subscriptionsUnchanged && badge === '';
  else if (mode === 'before-revoke') {
    if (!enabled || !subscriptionsUnchanged) throw new Error('revoke baseline unavailable');
    host.__qaRevokeHistoryDigest = historyDigest;
    host.__qaRevokeGeneration = grant.generation;
    host.__qaTabId = tabs[0].id;
    passed = true;
  } else if (mode === 'revoked') passed = !permitted && !permissions.origins.includes(pattern) && exactScripts.length === 0
    && grant?.enabled === false && grant.generation === host.__qaRevokeGeneration + 1
    && historyDigest === host.__qaRevokeHistoryDigest && subscriptionsUnchanged && badge === '';
  else throw new Error('unknown site observation mode');
  return { passed, historyCount: history.length, subscriptionCount: subscriptions.length };
}

// Human-only re-enable action/Settings cycle; no new Chrome dialog required. Retain digests/counts, not records.
export async function observePermissionCycle(api, mode, origin, host = globalThis, validate, siteObserve = observeSiteState) {
  if (!/^https:\/\/checkout-a\.test:[1-9]\d{0,4}$/.test(origin) || Number(new URL(origin).port) > 65535) throw new Error('invalid cycle origin');
  const stored = await api.storage.local.get(null);
  validate(stored);
  const history = stored.reviewHistory ?? [];
  const subscriptions = stored.subscriptions ?? [];
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const stable = [...history].sort((a, b) => a.id.localeCompare(b.id)).map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'latestSeen')));
  const identity = await digest(stable);
  const subs = await digest(subscriptions);
  const rest = await digest(Object.fromEntries(Object.entries(stored).filter(([key]) => !['reviewHistory', 'subscriptions', 'receipts', 'grantState'].includes(key))));
  const others = await digest(Object.fromEntries(Object.entries(stored.grantState?.sites ?? {}).filter(([key]) => key !== origin)));
  const grant = stored.grantState?.sites?.[origin];
  const result = (passed) => ({ passed, historyCount: history.length, subscriptionCount: subscriptions.length });
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  // A human may be viewing chrome://extensions in this same runner window.
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id) || (tabs[0].url !== undefined && new URL(tabs[0].url).origin !== origin)) return result(false);
  if (mode === 'baseline') {
    const previous = await siteObserve(api, 'revoked', origin, host, validate);
    if (!previous.passed || !history.some((item) => item.origin === origin && item.kind === 'recurring-charge')) throw new Error('permission cycle revoked baseline unavailable');
    host.__qaCycle = { identity, subs, rest, others, generation: grant.generation, tab: tabs[0].id };
    return result(true);
  }
  const state = host.__qaCycle;
  if (!state) throw new Error('permission cycle baseline missing');
  if (tabs[0].id !== state.tab || identity !== state.identity || subs !== state.subs || rest !== state.rest || others !== state.others) return result(false);
  if (mode === 'reenabled') {
    if (tabs[0].url === undefined || grant?.enabled !== true || grant.generation !== state.generation + 1) return result(false);
    // Existing exact Chrome permission/script/badge predicate, but no new IDs.
    return result((await siteObserve(api, 'before-revoke', origin, host, validate)).passed
      && await api.action.getBadgeText({ tabId: state.tab }) === '1');
  }
  if (mode === 'before-settings') {
    if (grant?.enabled !== true || grant.generation !== state.generation + 1) throw new Error('Settings baseline generation invalid');
    const readback = await siteObserve(api, 'before-revoke', origin, host, validate);
    if (readback.passed) state.settingsGeneration = grant.generation;
    return result(readback.passed);
  }
  if (mode === 'settings-removed') {
    if (!Number.isSafeInteger(state.settingsGeneration) || grant?.enabled !== false || grant.generation !== state.settingsGeneration + 1) return result(false);
    return result((await siteObserve(api, 'revoked', origin, host, validate)).passed);
  }
  throw new Error('unknown permission cycle mode');
}

// Read-only lifecycle identities; latestSeen may advance on a genuine rescan.
export async function observeAutomaticLifecycle(api, mode, origin, host = globalThis, validate) {
  const stored = await api.storage.local.get(null);
  validate(stored);
  const history = stored.reviewHistory ?? [];
  const subscriptions = stored.subscriptions ?? [];
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const sorted = (items) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  const stable = (items) => sorted(items).map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'latestSeen')));
  const result = (passed) => ({ passed, historyCount: history.length, subscriptionCount: subscriptions.length });
  if (mode === 'baseline') {
    const first = history.filter((item) => item.origin === origin && item.kind === 'recurring-charge' && item.ordinal === 1);
    if (first.length !== 1 || subscriptions.length !== 0) throw new Error('automatic lifecycle baseline unavailable');
    const ids = await Promise.all([1, 2].map(async (ordinal) => 'f_' + await digest([origin, first[0].opaqueFingerprint, ordinal])));
    if (first[0].id !== ids[0]) throw new Error('automatic lifecycle canonical identity invalid');
    host.__qaAutoIds = await digest([...new Set([...history.map((item) => item.id), ...ids])].sort());
    host.__qaAutoOthers = await digest(sorted(history.filter((item) => !ids.includes(item.id))));
    host.__qaAutoCount = new Set([...history.map((item) => item.id), ...ids]).size;
    return result(true);
  }
  const pair = history.filter((item) => item.origin === origin && item.kind === 'recurring-charge');
  let passed = subscriptions.length === 0 && pair.length === 2 && pair[0].screenedExcerpt === pair[1].screenedExcerpt
    && pair[0].opaqueFingerprint === pair[1].opaqueFingerprint && new Set(pair.map((item) => item.ordinal)).size === 2
    && pair.every((item) => [1, 2].includes(item.ordinal) && item.status === 'needs-review');
  for (const item of pair) passed &&= item.id === 'f_' + await digest([origin, item.opaqueFingerprint, item.ordinal]);
  passed &&= history.length === host.__qaAutoCount && await digest(history.map((item) => item.id).sort()) === host.__qaAutoIds
    && await digest(sorted(history.filter((item) => !pair.includes(item)))) === host.__qaAutoOthers;
  const stableDigest = await digest(stable(history));
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id) || new URL(tabs[0].url).origin !== origin) throw new Error('automatic lifecycle tab drift');
  const badge = await api.action.getBadgeText({ tabId: tabs[0].id });
  if (mode === 'distinct') {
    passed &&= badge === '2' && (!host.__qaAutoStable || host.__qaAutoStable === stableDigest);
    if (passed) host.__qaAutoStable = stableDigest;
  } else if (mode === 'repeat' || mode === 'before-exit') {
    passed &&= badge === '2' && stableDigest === host.__qaAutoStable;
    if (passed && mode === 'before-exit') host.__qaAutoExit = await digest(sorted(history));
  } else if (mode === 'exit') passed &&= badge === '' && await digest(sorted(history)) === host.__qaAutoExit;
  else throw new Error('unknown automatic lifecycle mode');
  return result(passed);
}

// Read-only human CRUD observer. Retained state contains digests/counts only.
export async function observeHistorySubscriptions(api, mode, origin, host = globalThis, validate) {
  const stored = await api.storage.local.get(null);
  if (typeof validate !== 'function') throw new Error('readback storage validator unavailable');
  validate(stored);
  const history = stored.reviewHistory ?? [];
  const subscriptions = stored.subscriptions ?? [];
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const historyDigest = await digest(history);
  const subscriptionDigest = await digest(subscriptions);
  const restDigest = await digest(Object.fromEntries(Object.entries(stored).filter(([key]) => !['reviewHistory', 'subscriptions'].includes(key))));
  const result = (passed) => ({ passed, historyCount: history.length, subscriptionCount: subscriptions.length });
  if (mode === 'baseline') {
    if (!/^https:\/\/checkout-a\.test:[1-9]\d{0,4}$/.test(origin) || Number(new URL(origin).port) > 65535) throw new Error('invalid mock origin');
    const target = [...history].sort((a, b) => b.latestSeen.localeCompare(a.latestSeen) || a.id.localeCompare(b.id)).find((item) => item.origin === origin && item.kind === 'recurring-charge' && item.status === 'needs-review');
    if (!target || subscriptions.length !== 0) throw new Error('human CRUD baseline unavailable: retained unreviewed recurring observation and zero subscriptions required; reset only through human UI and rerun');
    host.__qaCrud = { targetDigest: await digest(target.id), historyDigest,
      reviewedDigest: await digest(history.map((item) => item.id === target.id ? { ...item, status: 'reviewed' } : item)),
      subscriptionDigest, restDigest, phase: 0 };
    return { ...result(true), targetDigest: host.__qaCrud.targetDigest };
  }
  const state = host.__qaCrud;
  if (!state || restDigest !== state.restDigest) throw new Error('human CRUD baseline or settings changed');
  if (mode === 'history') return result(state.phase === 0 && historyDigest === state.historyDigest && subscriptionDigest === state.subscriptionDigest);
  if (mode === 'reviewed') {
    const passed = [0, 1].includes(state.phase) && historyDigest === state.reviewedDigest && subscriptions.length === 0;
    if (passed) { state.phase = 1; state.historyDigest = historyDigest; }
    return result(passed);
  }
  if (mode === 'history-delete-baseline') {
    if (state.phase !== 2 || historyDigest !== state.historyDigest || subscriptionDigest !== state.subscriptionDigest) throw new Error('history delete baseline changed');
    const target = history.find((item) => item.origin === origin && item.kind === 'recurring-charge' && !subscriptions.some((sub) => sub.sourceFindingId === item.id));
    if (!target) throw new Error('history delete requires a non-source duplicate');
    state.deleteDigest = await digest(target.id);
    state.deletedHistoryDigest = await digest(history.filter((item) => item.id !== target.id));
    return { ...result(true), deleteDigest: state.deleteDigest,
      dialogDigest: await digest(`Permanently delete observation ${target.id} from ${target.origin}?`) };
  }
  if (mode === 'history-delete-cancelled') return result(state.phase === 2 && historyDigest === state.historyDigest && subscriptionDigest === state.subscriptionDigest);
  if (mode === 'history-deleted') {
    const passed = state.phase === 2 && historyDigest === state.deletedHistoryDigest && subscriptionDigest === state.subscriptionDigest;
    if (passed) state.historyDigest = historyDigest;
    return result(passed);
  }
  if (historyDigest !== state.historyDigest) return result(false);
  if (mode === 'unchanged') return result(subscriptionDigest === state.subscriptionDigest);
  const matches = (item, merchant, amount, cadence) => item.merchant === merchant && item.amount === amount && item.currency === 'USD' && item.cadence === cadence
    && !['notes', 'nextBillingDate', 'customDescription'].some((key) => Object.hasOwn(item, key));
  if (mode === 'confirmed') {
    if (state.phase === 2) return result(subscriptionDigest === state.subscriptionDigest);
    const item = subscriptions[0];
    const passed = [1, 2].includes(state.phase) && subscriptions.length === 1 && matches(item, 'QA Finding Mock', '12.34', 'monthly')
      && await digest(item.sourceFindingId) === state.targetDigest;
    if (passed) { state.phase = 2; state.confirmedDigest = await digest(item); state.subscriptionDigest = subscriptionDigest; }
    return result(passed);
  }
  const confirmed = subscriptions.filter((item) => Object.hasOwn(item, 'sourceFindingId'));
  if (confirmed.length !== 1 || await digest(confirmed[0]) !== state.confirmedDigest) return result(false);
  const manual = subscriptions.filter((item) => !Object.hasOwn(item, 'sourceFindingId'));
  if (mode === 'added') {
    if (state.phase === 3) return result(subscriptionDigest === state.subscriptionDigest);
    const passed = [2, 3].includes(state.phase) && subscriptions.length === 2 && manual.length === 1 && matches(manual[0], 'QA Manual Mock', '23.45', 'yearly');
    if (passed) { state.phase = 3; state.manualIdentityDigest = await digest({ id: manual[0].id, createdAt: manual[0].createdAt }); state.manualUpdatedAtDigest = await digest(manual[0].updatedAt); state.subscriptionDigest = subscriptionDigest; }
    return result(passed);
  }
  if (mode === 'edited') {
    if (state.phase === 4) return result(subscriptionDigest === state.subscriptionDigest);
    const passed = [3, 4].includes(state.phase) && subscriptions.length === 2 && manual.length === 1 && matches(manual[0], 'QA Manual Mock Edited', '34.56', 'weekly')
      && await digest({ id: manual[0].id, createdAt: manual[0].createdAt }) === state.manualIdentityDigest
      && await digest(manual[0].updatedAt) !== state.manualUpdatedAtDigest;
    if (passed) { state.phase = 4; state.subscriptionDigest = subscriptionDigest; }
    return result(passed);
  }
  if (mode === 'deleted') return result(state.phase === 4 && subscriptions.length === 1 && manual.length === 0);
  throw new Error('unknown human CRUD observation mode');
}

// Genuine popup DOM readback, never clicks/fills or returns record contents.
export async function observeHistorySubscriptionUi(mode, targetDigest, deleteDigest) {
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const rows = Array.from(document.querySelectorAll('[data-review-id]'));
  let target;
  for (const row of rows) if (await digest(row.dataset.reviewId) === targetDigest) target = row;
  let deletionTarget;
  for (const row of rows) if (await digest(row.dataset.reviewId) === deleteDigest) deletionTarget = row;
  if (mode === 'history-delete-cancelled' || mode === 'history-deleted') return !!target
    && target.querySelector('[data-action="review-mark"]')?.dataset.reviewed === 'true'
    && document.querySelectorAll('[data-subscription-list] > article').length === 1
    && (mode === 'history-deleted' ? !deletionTarget : !!deletionTarget);
  const editor = document.querySelector('[data-subscription-editor]');
  const status = document.querySelector('section[aria-label="Subscriptions"] > [role="status"]')?.textContent;
  const count = document.querySelectorAll('[data-subscription-list] > article').length;
  const closed = editor?.childElementCount === 0;
  if (mode === 'history') return !!target && target.querySelector('[data-action="review-mark"]')?.disabled === false && count === 0
    && /^Showing .* retained observations \(including reviewed\)\.$/.test(document.querySelector('[data-review-status]')?.textContent ?? '');
  if (mode === 'reviewed') return !!target && target.querySelector('[data-action="review-mark"]')?.dataset.reviewed === 'true'
    && target.querySelector('[data-action="review-mark"]')?.disabled === true && count === 0;
  if (mode === 'draft') return editor?.querySelector('h3')?.textContent === 'Confirm observation as subscription'
    && ['merchant', 'amount', 'currency', 'cadence'].every((name) => editor.querySelector(`[name="${name}"]`)?.value === '')
    && status === 'Save explicitly to confirm changes.' && count === 0;
  if (mode === 'cancelled') return closed && count === 0 && status === 'Editor closed; no additional save requested.';
  if (mode === 'saved-one') return closed && count === 1 && status === 'Subscription saved locally.';
  if (mode === 'saved-two') return closed && count === 2 && status === 'Subscription saved locally.';
  if (mode === 'delete-prompt') return count === 2 && editor?.querySelector('[aria-label="Delete confirmation"] h3')?.textContent === 'Delete subscription?'
    && editor.querySelector('[aria-label="Delete confirmation"] p')?.textContent === 'QA Manual Mock Edited';
  if (mode === 'closed-two') return closed && count === 2;
  if (mode === 'deleted-one') return closed && count === 1 && status === 'Subscription deleted locally.';
  throw new Error('unknown human CRUD popup mode');
}

// Read-only final checkpoints: retain only hashes, never fixture records.
export async function observeFinalState(api, mode, origin, expectedWorkerUrl, baseline, validate) {
  const stored = await api.storage.local.get(null);
  validate(stored);
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const permissions = await api.permissions.getAll();
  const scripts = await api.scripting.getRegisteredContentScripts();
  const history = stored.reviewHistory ?? [];
  const subscriptions = stored.subscriptions ?? [];
  const grant = stored.grantState?.sites?.[origin];
  if (api.runtime.getURL('worker.js') !== expectedWorkerUrl || api.runtime.id !== new URL(expectedWorkerUrl).hostname
    || !Array.isArray(permissions.origins) || permissions.origins.length !== 0 || scripts.length !== 0
    || await api.permissions.contains({ origins: [origin + '/*'] }) || grant?.enabled !== false || !(grant.generation > 0)) throw new Error('final worker identity or revoked browser state invalid');
  const snapshot = { history: await digest(history), subscriptions: await digest(subscriptions),
    rest: await digest(Object.fromEntries(Object.entries(stored).filter(([key]) => !['reviewHistory', 'subscriptions', 'retentionPolicy'].includes(key)))),
    policy: stored.retentionPolicy ?? 30 };
  if (mode === 'baseline') {
    if (subscriptions.length !== 1 || !subscriptions[0].sourceFindingId
      || !history.some((item) => item.id === subscriptions[0].sourceFindingId && item.origin === origin && item.status === 'reviewed')
      || history.some((item) => Date.parse(item.latestSeen) <= Date.now() - 7 * 86400000)) throw new Error('final baseline requires fresh retained source and one confirmed subscription');
    return snapshot;
  }
  if (!baseline || !['retention', 'unchanged'].includes(mode)) throw new Error('final baseline or mode unavailable');
  return snapshot.history === baseline.history && snapshot.subscriptions === baseline.subscriptions
    && snapshot.rest === baseline.rest && snapshot.policy === (mode === 'retention' ? 7 : baseline.policy);
}

export function observeFinalUi(mode, origin) {
  const section = document.querySelector('section[aria-label="Subscriptions"]');
  const rows = Array.from(document.querySelectorAll('[data-subscription-list] > article'));
  if (rows.length !== 1 || !section?.textContent.includes('Delete removes the local record only; it does not cancel billing.')) return false;
  const retention = document.querySelector('[data-review-retention]');
  if (!retention || retention.disabled || retention.value !== '7') return false;
  if (mode === 'retention') return true;
  if (mode === 'restart') return rows[0].textContent.includes('QA Finding Mock')
    && Array.from(document.querySelectorAll('[data-review-id]')).some((row) => row.querySelector('[data-action="review-mark"]')?.dataset.reviewed === 'true'
      && row.querySelector('[data-action="review-mark"]')?.disabled === true);
  if (mode !== 'help') throw new Error('unknown final popup mode');
  // The controlled mock has a nonempty port: production guide-catalog rejects
  // it as NONE. Never strip that port or invent provider/fallback provenance.
  if (!/^https:\/\/checkout-a\.test:[1-9]\d{0,4}$/.test(origin) || Number(new URL(origin).port) > 65535 || new URL(origin).port === '') return false;
  return section.querySelectorAll('a').length === 0
    && rows[0].querySelector('[role="status"]')?.textContent === 'No known provider site; check your billing provider';
}

// Pristine clean-stage schema only, not a general loader. Nonempty or corrupt
// records are rejected, never defaulted or ignored. Serialized into the worker.
export async function observeCleanState(api, mode, targetUrl, host = globalThis) {
  const stored = await api.storage.local.get(null);
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const has = (key) => Object.hasOwn(stored, key);
  const empty = (value) => Array.isArray(value) && value.length === 0;
  const keys = ['version', 'dismissed', 'subscriptions', 'reviewHistory', 'retentionPolicy', 'receipts', 'grantState'];
  const valid = record(stored) && Object.keys(stored).every((key) => keys.includes(key))
    && (!has('dismissed') || typeof stored.dismissed === 'boolean')
    && (!has('version') || stored.version === 1)
    && (!has('subscriptions') || empty(stored.subscriptions))
    && (!has('reviewHistory') || empty(stored.reviewHistory))
    // Successful clean Analyze writes an idempotency receipt, not a finding.
    // Keep pristine capture empty; compare permits only bounded, exact-schema
    // receipts whose outcomes contain zero finding IDs.
    && (!has('receipts') || (Array.isArray(stored.receipts) && stored.receipts.length <= 500
      && (mode !== 'capture' || stored.receipts.length === 0)
      && stored.receipts.every((item) => record(item) && Object.keys(item).length === 3
        && ['requestId', 'digest', 'outcome'].every((key) => Object.hasOwn(item, key))
        && typeof item.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.requestId)
        && typeof item.digest === 'string' && /^[a-f0-9]{64}$/.test(item.digest)
        && record(item.outcome) && Object.keys(item.outcome).length === 1 && empty(item.outcome.ids))
      && new Set(stored.receipts.map((item) => item.requestId)).size === stored.receipts.length))
    && (!has('retentionPolicy') || [7, 30, 90, 'never'].includes(stored.retentionPolicy))
    && (has('version') ? has('subscriptions') && has('reviewHistory')
      : !['subscriptions', 'reviewHistory', 'retentionPolicy', 'receipts'].some(has))
    && (!has('grantState') || (record(stored.grantState)
      && Object.keys(stored.grantState).length === 2 && stored.grantState.version === 1
      && record(stored.grantState.sites) && Object.keys(stored.grantState.sites).length === 0));
  if (!valid) throw new Error('clean storage schema or empty-collection predicate failed');
  const permissions = await api.permissions.getAll();
  const scripts = await api.scripting.getRegisteredContentScripts();
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  // Before a human gesture, activeTab does not expose the URL. Bind its numeric
  // tab ID now; require the exact fixture URL after the genuine Analyze grant.
  const matches = tabs.filter((tab) => Number.isInteger(tab.id)
    && (tab.url === targetUrl || (mode === 'capture' && tab.url === undefined)));
  if (!Array.isArray(permissions.origins) || !Array.isArray(scripts) || matches.length !== 1
    || (mode === 'compare' && matches[0].id !== host.__clearchoiceCleanTabId)) {
    throw new Error('clean browser readback unavailable');
  }
  const badgeBlank = await api.action.getBadgeText({ tabId: matches[0].id }) === '';
  const snapshot = JSON.stringify({ history: stored.reviewHistory ?? [], subscriptions: stored.subscriptions ?? [] });
  if (mode === 'capture') {
    host.__clearchoiceCleanSnapshot = snapshot;
    host.__clearchoiceCleanTabId = matches[0].id;
  }
  else if (mode !== 'compare' || typeof host.__clearchoiceCleanSnapshot !== 'string') {
    throw new Error('clean readback baseline unavailable');
  }
  return {
    storageValid: true, historyCount: (stored.reviewHistory ?? []).length,
    subscriptionCount: (stored.subscriptions ?? []).length,
    unchanged: snapshot === host.__clearchoiceCleanSnapshot,
    permissionCount: permissions.origins.length, scriptCount: scripts.length,
    grantCount: Object.keys(stored.grantState?.sites ?? {}).length, badgeBlank,
  };
}
