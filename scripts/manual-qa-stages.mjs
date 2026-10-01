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
