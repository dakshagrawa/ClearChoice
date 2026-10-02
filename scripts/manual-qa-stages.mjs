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
export async function observeHistorySubscriptionUi(mode, targetDigest) {
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const rows = Array.from(document.querySelectorAll('[data-review-id]'));
  let target;
  for (const row of rows) if (await digest(row.dataset.reviewId) === targetDigest) target = row;
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
    && (!has('receipts') || empty(stored.receipts))
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
