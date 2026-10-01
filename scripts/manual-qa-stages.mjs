/* global setTimeout, crypto, TextEncoder */
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
export async function observeSiteState(api, mode, origin, host = globalThis) {
  if (!/^https:\/\/checkout-[ab]\.test:[1-9]\d{0,4}$/.test(origin) || new URL(origin).port > 65535) throw new Error('invalid mock origin');
  const stored = await api.storage.local.get(null);
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
