// @vitest-environment node
import { expect, test } from 'vitest';
import { runInNewContext } from 'node:vm';
const validate = runInNewContext(await storageValidatorSource(), { Intl, URL });
import { WORKFLOW_PREDICATES } from '../scripts/active-tab-qa.mjs';
import { createManualActiveTabQaMarker, runFinalCheckpoints } from '../scripts/manual-active-tab-qa.mjs';
import { storageValidatorSource, observePermissionCycle, observeFinalState, observeFinalUi, observeHistorySubscriptions, runHumanStage, runWithCleanup, observeCleanState, observeSiteState, waitForObservation } from '../scripts/manual-qa-stages.mjs';

test('second consent derives generations and Settings observer rejects partial cleanup and identity changes', async () => {
  const { state, finding, confirmed } = crudFixture();
  const origin = finding.origin;
  state.subscriptions = [confirmed]; // Also prove linked subscriptions survive.
  state.grantState = { version: 1, sites: { [origin]: { enabled: false, generation: 8 } } };
  const api = cleanApi(state);
  let permitted = false;
  let scripts = [];
  let badge = '';
  api.permissions.getAll = async () => ({ origins: permitted ? [origin + '/*'] : [] });
  api.permissions.contains = async () => permitted;
  api.scripting.getRegisteredContentScripts = async () => scripts;
  api.action.getBadgeText = async () => badge;
  const host = {};
  await observeSiteState(api, 'baseline', origin, host, validate);
  host.__qaRevokeGeneration = 7;
  host.__qaRevokeHistoryDigest = host.__qaHistoryDigest;
  const read = (mode) => observePermissionCycle(api, mode, origin, host, validate);
  await expect(observePermissionCycle(api, 'reenabled', origin, {}, validate)).rejects.toThrow('baseline');
  expect((await read('baseline')).passed).toBe(true);
  const script = { id: 'clearchoice-site-b93005a526dc3134fdd360798aad3e73fbb20a3d50c16ebe605a4d4947098925', matches: [origin + '/*'], js: ['content.js'], allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' };
  permitted = true; scripts = [script]; badge = '1';
  state.grantState.sites[origin] = { enabled: true, generation: 8 };
  expect((await read('reenabled')).passed).toBe(false); // Reused generation.
  state.grantState.sites[origin].generation = 9;
  finding.latestSeen = '2026-10-01T00:01:00.000Z';
  expect((await read('reenabled')).passed).toBe(true);
  finding.id = 'f_replaced';
  expect((await read('reenabled')).passed).toBe(false);
  finding.id = 'f_mock';
  confirmed.amount = '99.99';
  expect((await read('reenabled')).passed).toBe(false);
  confirmed.amount = '12.34';
  expect((await read('before-settings')).passed).toBe(true);
  permitted = false;
  expect((await read('settings-removed')).passed).toBe(false); // Permission alone.
  state.grantState.sites[origin] = { enabled: false, generation: 10 };
  expect((await read('settings-removed')).passed).toBe(false); // Script remains.
  scripts = [];
  expect((await read('settings-removed')).passed).toBe(false); // Badge remains.
  badge = '';
  expect((await read('settings-removed')).passed).toBe(true);
  api.tabs.query = async () => [{ id: 7, url: 'https://checkout-b.test:123/checkout/clean' }];
  expect((await read('settings-removed')).passed).toBe(false);
  api.tabs.query = async () => [{ id: 7 }];
  delete state.grantState.sites[origin];
  expect((await read('settings-removed')).passed).toBe(false);
  state.reviewHistory = [{}];
  await expect(read('settings-removed')).rejects.toThrow('schema');
  expect(Object.values(host.__qaCycle).every((value) => typeof value === 'number' || /^[a-f0-9]{64}$/.test(value))).toBe(true);
});

test('exact clean readback rejects nested arrays and malformed storage rather than ignoring it', async () => {
  for (const state of [{ localState: { version: 1, reviewHistory: [{}], subscriptions: [] } },
    { version: 1, reviewHistory: {}, subscriptions: [] }, { version: 2, reviewHistory: [], subscriptions: [] },
    { version: 1, reviewHistory: [], subscriptions: [], grantState: { version: 1, sites: { bad: {} } } },
    { subscriptions: [], reviewHistory: [] }, { dismissed: 'false' }, { receipts: [] },
    null, [], { version: 1, subscriptions: [], reviewHistory: [], receipts: [{}] },
    { version: 1, subscriptions: [], reviewHistory: [], retentionPolicy: {} }]) {
    await expect(observeCleanState(cleanApi(state), 'capture', 'https://checkout-a.test:123/checkout/clean', {})).rejects.toThrow('clean storage schema');
  }
});

test('clean comparison accepts validated zero-finding receipts but never nonempty outcomes or malformed receipts', async () => {
  const state = { version: 1, reviewHistory: [], subscriptions: [], receipts: [] };
  const host = {};
  const api = cleanApi(state);
  const url = 'https://checkout-a.test:123/checkout/clean';
  await observeCleanState(api, 'capture', url, host);
  const receipt = { requestId: 'mock_clean_request', digest: 'a'.repeat(64), outcome: { ids: [] } };
  state.receipts = [receipt];
  await expect(observeCleanState(api, 'compare', url, host)).resolves.toMatchObject({ storageValid: true, unchanged: true, historyCount: 0, subscriptionCount: 0 });
  await expect(observeCleanState(api, 'capture', url, {})).rejects.toThrow('clean storage schema');
  for (const receipts of [[{}], [{ ...receipt, extra: true }], [{ ...receipt, digest: 'bad' }],
    [{ ...receipt, requestId: '' }], [{ ...receipt, outcome: { ids: [], extra: true } }],
    [{ ...receipt, outcome: { ids: ['f_' + 'b'.repeat(64)] } }], [receipt, receipt], Array(501).fill(receipt)]) {
    state.receipts = receipts;
    await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow('clean storage schema');
  }
});

function cleanApi(state) {
  return {
    storage: { local: { get: async () => state } },
    permissions: { getAll: async () => ({ origins: [] }) },
    scripting: { getRegisteredContentScripts: async () => [] },
    tabs: { query: async () => [{ id: 7, url: 'https://checkout-a.test:123/checkout/clean' }] },
    action: { getBadgeText: async ({ tabId }) => { expect(tabId).toBe(7); return ''; } },
  };
}

test('pristine and genuine initialized schemas yield only predicates and counts', async () => {
  for (const state of [{}, { dismissed: false }, { version: 1, reviewHistory: [], subscriptions: [], retentionPolicy: 30, receipts: [], grantState: { version: 1, sites: {} } }]) {
    const host = {};
    const api = cleanApi(state);
    const url = 'https://checkout-a.test:123/checkout/clean';
    const before = await observeCleanState(api, 'capture', url, host);
    const after = await observeCleanState(api, 'compare', url, host);
    expect(after).toEqual(before);
    expect(after).toEqual({ storageValid: true, historyCount: 0, subscriptionCount: 0, unchanged: true, permissionCount: 0, scriptCount: 0, grantCount: 0, badgeBlank: true });
    expect(Object.values(after).every((value) => typeof value === 'boolean' || typeof value === 'number')).toBe(true);
    state.reviewHistory = [{}];
    await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow();
  }
});

test('browser predicates use genuine API results and fail closed on missing baseline or tab drift', async () => {
  const api = cleanApi({});
  const host = {};
  const url = 'https://checkout-a.test:123/checkout/clean';
  await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow();
  await observeCleanState(api, 'capture', url, host);
  api.permissions.getAll = async () => ({ origins: ['https://checkout-a.test/*'] });
  api.scripting.getRegisteredContentScripts = async () => [{ id: 'unexpected' }];
  api.action.getBadgeText = async () => '1';
  expect(await observeCleanState(api, 'compare', url, host)).toMatchObject({ permissionCount: 1, scriptCount: 1, badgeBlank: false });
  api.tabs.query = async () => [{ id: 8, url }];
  await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow('browser readback unavailable');
  api.tabs.query = async () => [{ id: 7, url: 'https://checkout-a.test:123/other' }];
  await expect(observeCleanState(api, 'compare', url, host)).rejects.toThrow('browser readback unavailable');
});

test('cleanup preserves setup or workflow failure and attempts every closer exactly once', async () => {
  for (const phase of ['setup', 'workflow', 'archive']) {
    const primary = new Error(phase);
    const events = [];
    await expect(runWithCleanup(async () => { throw primary; }, [
      async () => { events.push('browser'); throw new Error('close failed'); },
      async () => { events.push('candidate'); throw new Error('candidate cleanup failed'); },
      async () => { events.push('tls'); },
    ])).rejects.toBe(primary);
    expect(events).toEqual(['browser', 'candidate', 'tls']);
  }
});

test('cleanup-only failure is surfaced rather than silently discarded', async () => {
  const failure = new Error('candidate cleanup failed');
  await expect(runWithCleanup(async () => true, [async () => { throw failure; }])).rejects.toBe(failure);
});

test('site readback binds exact permission, grant and script; revoke preserves records without creating subscriptions', async () => {
  const origin = 'https://checkout-a.test:123';
  const state = { version: 1, reviewHistory: [], subscriptions: [{ id: 'fake-confirmed', merchant: 'Synthetic Mock', amount: '1.00', currency: 'USD', cadence: 'monthly', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }], grantState: { version: 1, sites: {} } };
  const api = cleanApi(state);
  const host = {};
  await observeSiteState(api, 'baseline', origin, host, validate);
  api.tabs.query = async () => [{ id: 7 }];
  expect((await observeSiteState(api, 'enabled', origin, host, validate)).passed).toBe(false);
  api.tabs.query = async () => [{ id: 7, url: origin + '/checkout/clean' }];
  api.permissions.getAll = async () => ({ origins: [origin + '/*'] });
  api.permissions.contains = async () => true;
  state.grantState.sites[origin] = { enabled: true, generation: 1 };
  const script = { id: 'clearchoice-site-b93005a526dc3134fdd360798aad3e73fbb20a3d50c16ebe605a4d4947098925', matches: [origin + '/*'], js: ['content.js'], allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' };
  api.scripting.getRegisteredContentScripts = async () => [script];
  expect((await observeSiteState(api, 'enabled', origin, host, validate)).passed).toBe(true);
  state.grantState.sites[origin].generation = 0;
  await expect(observeSiteState(api, 'enabled', origin, host, validate)).rejects.toThrow('schema');
  state.grantState.sites[origin].generation = 1;
  api.permissions.getAll = async () => ({ origins: ['https://checkout-b.test:123/*'] });
  expect((await observeSiteState(api, 'enabled', origin, host, validate)).passed).toBe(false);
  api.permissions.getAll = async () => ({ origins: [origin + '/*'] });
  state.subscriptions.push({ ...state.subscriptions[0], id: 'unwanted-auto-created' });
  expect((await observeSiteState(api, 'enabled', origin, host, validate)).passed).toBe(false);
  state.subscriptions.pop();
  script.world = 'MAIN';
  expect((await observeSiteState(api, 'enabled', origin, host, validate)).passed).toBe(false);
  script.world = 'ISOLATED';
  state.reviewHistory.push({ origin, kind: 'recurring-charge', reason: 'price-cadence', id: 'fake-observation', screenedExcerpt: '$1.00 monthly', opaqueFingerprint: 'a'.repeat(64), ordinal: 1, firstSeen: '2026-01-01T00:00:00.000Z', latestSeen: '2026-01-01T00:00:00.000Z', status: 'needs-review' });
  api.action.getBadgeText = async () => '1';
  expect((await observeSiteState(api, 'positive', origin, host, validate)).passed).toBe(true);
  await observeSiteState(api, 'before-revoke', origin, host, validate);
  expect((await observeSiteState(api, 'revoked', origin, host, validate)).passed).toBe(false);
  state.grantState.sites[origin] = { enabled: false, generation: 2 };
  api.permissions.getAll = async () => ({ origins: [] });
  api.permissions.contains = async () => false;
  api.scripting.getRegisteredContentScripts = async () => [];
  api.action.getBadgeText = async () => '';
  expect((await observeSiteState(api, 'revoked', origin, host, validate)).passed).toBe(true);
  state.reviewHistory.push({ ...state.reviewHistory[0], id: 'second-synthetic' });
  expect((await observeSiteState(api, 'revoked', origin, host, validate)).passed).toBe(false);
  expect(state.subscriptions).toHaveLength(1);
  expect(state.subscriptions[0].id).toBe('fake-confirmed');
  api.tabs.query = async () => [{ id: 7, url: 'https://wrong.test/' }];
  await expect(observeSiteState(api, 'revoked', origin, host, validate)).rejects.toThrow('tab');
  expect(Object.values(host).every((value) => typeof value === 'string' ? /^[a-f0-9]{64}$/.test(value) : typeof value === 'number')).toBe(true);
});

// Synthetic fixtures, never passed to a production mutating loader.
test('site readback rejects unsupported, incomplete and malformed nested schemas before capture or comparison', async () => {
  const origin = 'https://checkout-a.test:123';
  const valid = { version: 1, reviewHistory: [], subscriptions: [], retentionPolicy: 30, receipts: [], dismissed: false, grantState: { version: 1, sites: {} } };
  const malformed = [null, [], { ...valid, version: 999 }, { ...valid, subscriptions: [{ id: 'malformed' }] },
    { ...valid, reviewHistory: [{}] }, { ...valid, dismissed: 'false' }, { ...valid, retentionPolicy: 999 },
    { ...valid, receipts: [{}] }, { ...valid, receipts: [{ requestId: 'mock', digest: 'a'.repeat(64), outcome: { ids: ['bad'] } }] },
    { version: 1, subscriptions: [] }, { version: 1, reviewHistory: [] }, { subscriptions: [], reviewHistory: [] },
    { ...valid, grantState: { version: 999, sites: {} } }, { ...valid, grantState: { version: 1, sites: {}, extra: true } },
    { ...valid, grantState: { version: 1, sites: { [origin]: { enabled: true, generation: 1, extra: true } } } },
    { ...valid, grantState: { version: 1, sites: { [origin]: { enabled: true, generation: 0 } } } },
    { ...valid, grantState: { version: 1, sites: { 'https://127.0.0.1': { enabled: true, generation: 1 } } } }];
  for (const state of malformed) {
    const host = {};
    await expect(observeSiteState(cleanApi(state), 'baseline', origin, host, validate)).rejects.toThrow('schema');
    expect(host).toEqual({});
    await observeSiteState(cleanApi(valid), 'baseline', origin, host, validate);
    for (const mode of ['enabled', 'positive', 'quiet', 'before-revoke', 'revoked']) {
      await expect(observeSiteState(cleanApi(state), mode, origin, host, validate)).rejects.toThrow('schema');
    }
  }
  for (const state of [{}, { dismissed: false }, valid]) {
    expect((await observeSiteState(cleanApi(state), 'baseline', origin, {}, validate)).passed).toBe(true);
  }
});

test('readback validator accepts realistic nested receipts and rejects duplicate or surplus records', () => {
  const subscription = { id: 's_mock', merchant: 'Synthetic Mock', amount: '1.00', currency: 'USD', cadence: 'monthly', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const receipt = { requestId: 'mock', digest: 'b'.repeat(64), outcome: { ids: ['f_' + 'a'.repeat(64)] } };
  const state = { version: 1, reviewHistory: [], subscriptions: [subscription], receipts: [receipt] };
  expect(validate(state)).toBe(true);
  for (const changed of [{ ...state, subscriptions: [subscription, subscription] },
    { ...state, subscriptions: [{ ...subscription, extra: true }] },
    { ...state, receipts: [receipt, receipt] },
    { ...state, receipts: [{ ...receipt, outcome: { ...receipt.outcome, extra: true } }] }]) {
    expect(() => validate(changed)).toThrow('schema');
  }
});

test('missing permission cannot by itself prove human denial', async () => {
  let ack = false;
  await expect(runHumanStage({ instruction: 'Deny.', instruct: () => {}, observe: async () => false,
    acknowledge: async () => { ack = true; return 'DONE'; } })).rejects.toThrow('observable');
  expect(ack).toBe(false);
});

test('bounded observation retries pending state and fails truthfully on timeout', async () => {
  let attempts = 0;
  await expect(waitForObservation(async () => ++attempts === 2, { timeoutMs: 100, intervalMs: 1 })).resolves.toBe(true);
  await expect(waitForObservation(async () => false, { timeoutMs: 5, intervalMs: 1 })).rejects.toThrow('timed out');
});

const candidate = { commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), archiveSha256: 'c'.repeat(64) };

// Explicit synthetic unit snapshots, not real human popup/storage evidence.
function crudFixture() {
  const origin = 'https://checkout-a.test:123';
  const instant = '2026-10-01T00:00:00.000Z';
  const finding = { origin, kind: 'recurring-charge', reason: 'price-cadence', id: 'f_mock', screenedExcerpt: '$1.00 monthly', opaqueFingerprint: 'a'.repeat(64), ordinal: 1, firstSeen: instant, latestSeen: instant, status: 'needs-review' };
  const state = { version: 1, reviewHistory: [finding], subscriptions: [], retentionPolicy: 30, receipts: [] };
  const host = {};
  const read = (mode) => observeHistorySubscriptions(cleanApi(state), mode, origin, host, validate);
  const confirmed = { id: 's_finding', merchant: 'QA Finding Mock', amount: '12.34', currency: 'USD', cadence: 'monthly', createdAt: instant, updatedAt: instant, sourceFindingId: finding.id };
  const manual = { id: 's_manual', merchant: 'QA Manual Mock', amount: '23.45', currency: 'USD', cadence: 'yearly', createdAt: instant, updatedAt: instant };
  return { state, host, read, finding, confirmed, manual };
}

test('synthetic CRUD checkpoints require exact history transition, explicit confirmation and correct provenance', async () => {
  const { state, host, read, finding, confirmed, manual } = crudFixture();
  expect((await read('baseline')).targetDigest).toMatch(/^[a-f0-9]{64}$/);
  expect((await read('history')).passed).toBe(true);
  expect((await read('reviewed')).passed).toBe(false);
  finding.status = 'reviewed';
  expect((await read('reviewed')).passed).toBe(true);
  expect(state.subscriptions).toEqual([]); // Mark reviewed is NOT confirmation.
  expect((await read('unchanged')).passed).toBe(true); // Blank draft/cancel.
  for (const wrong of [{ ...confirmed, sourceFindingId: 'f_wrong' }, { ...confirmed, amount: '99.00' }, { ...confirmed, notes: 'Unexpected' }]) {
    state.subscriptions = [wrong];
    expect((await read('confirmed')).passed).toBe(false);
    expect((await read('unchanged')).passed).toBe(false);
  }
  state.subscriptions = [confirmed, manual];
  expect((await read('confirmed')).passed).toBe(false);
  state.subscriptions = [confirmed];
  expect((await read('confirmed')).passed).toBe(true);
  state.subscriptions.push(manual);
  expect((await read('added')).passed).toBe(true);
  const prior = { ...manual };
  Object.assign(manual, { merchant: 'QA Manual Mock Edited', amount: '34.56', cadence: 'weekly', updatedAt: '2026-10-01T00:00:01.000Z' });
  manual.id = 's_replaced';
  expect((await read('edited')).passed).toBe(false);
  manual.id = prior.id;
  manual.sourceFindingId = finding.id;
  expect((await read('edited')).passed).toBe(false);
  delete manual.sourceFindingId;
  expect((await read('edited')).passed).toBe(true);
  expect((await read('unchanged')).passed).toBe(true); // Delete Cancel.
  state.subscriptions = [manual]; // Wrong deletion target.
  expect((await read('deleted')).passed).toBe(false);
  state.subscriptions = [];
  expect((await read('deleted')).passed).toBe(false);
  state.subscriptions = [{ ...confirmed, amount: '88.00' }];
  expect((await read('deleted')).passed).toBe(false);
  state.subscriptions = [confirmed];
  expect((await read('deleted')).passed).toBe(true);
  finding.screenedExcerpt = 'Changed mock';
  expect((await read('deleted')).passed).toBe(false);
  expect(Object.values(host.__qaCrud).every((value) => typeof value === 'number' || /^[a-f0-9]{64}$/.test(value))).toBe(true);
});

test('synthetic CRUD cancellation detects mutation and every mode rejects malformed storage', async () => {
  const { state, host, read, finding, confirmed } = crudFixture();
  await read('baseline');
  finding.status = 'reviewed';
  await read('reviewed');
  state.subscriptions = [confirmed];
  expect((await read('unchanged')).passed).toBe(false);
  state.subscriptions = [];
  const valid = structuredClone(state);
  for (const broken of [{ version: 2 }, { subscriptions: [{}] }, { reviewHistory: [{}] }, { retentionPolicy: 999 }, { receipts: [{}] }, { dismissed: 'false' }, { grantState: { version: 1, sites: { bad: {} } } }]) {
    Object.assign(state, valid, broken);
    for (const mode of ['baseline', 'history', 'reviewed', 'unchanged', 'confirmed', 'added', 'edited', 'deleted']) await expect(read(mode)).rejects.toThrow('schema');
    for (const key of Object.keys(state)) delete state[key];
  }
  Object.assign(state, valid);
  expect(host.__qaCrud.phase).toBe(1);
});

test('history delete Cancel preserves all data; confirmation removes only non-source duplicate', async () => {
  const { state, read, finding, confirmed } = crudFixture();
  const other = { ...finding, id: 'z_duplicate', ordinal: 2 };
  state.reviewHistory.push(other);
  await read('baseline'); finding.status = 'reviewed'; await read('reviewed');
  state.subscriptions = [confirmed]; await read('confirmed');
  const baseline = await read('history-delete-baseline');
  expect(baseline.deleteDigest).toMatch(/^[a-f0-9]{64}$/);
  const { createHash } = await import('node:crypto');
  expect(baseline.dialogDigest).toBe(createHash('sha256').update(JSON.stringify(`Permanently delete observation ${other.id} from ${other.origin}?`)).digest('hex'));
  expect(JSON.stringify(baseline)).not.toContain(other.id);
  expect(JSON.stringify(baseline)).not.toContain(other.origin);
  expect((await read('history-delete-cancelled')).passed).toBe(true);
  state.reviewHistory = [other];
  expect((await read('history-deleted')).passed).toBe(false);
  state.reviewHistory = [finding];
  expect((await read('history-deleted')).passed).toBe(true);
  expect((await read('unchanged')).passed).toBe(true);
  state.subscriptions[0].amount = '99.00';
  expect((await read('history-deleted')).passed).toBe(false);
});

test('already-reviewed synthetic baseline fails honestly instead of pretending a Mark transition occurred', async () => {
  const { finding, read, host } = crudFixture();
  finding.status = 'reviewed';
  await expect(read('baseline')).rejects.toThrow('reset only through human UI');
  expect(host).toEqual({});
});
test('automatic duplicate lifecycle binds canonical IDs, ordinals and stable provenance across repeats and SPA exit', async () => {
  const { observeAutomaticLifecycle } = await import('../scripts/manual-qa-stages.mjs');
  const { state, finding } = crudFixture();
  const { createHash } = await import('node:crypto');
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  finding.id = 'f_' + hash([finding.origin, finding.opaqueFingerprint, 1]);
  const api = cleanApi(state); const host = {};
  const read = (mode) => observeAutomaticLifecycle(api, mode, finding.origin, host, validate);
  expect((await read('baseline')).passed).toBe(true);
  state.reviewHistory.push({ ...finding, id: 'f_' + hash([finding.origin, finding.opaqueFingerprint, 2]), ordinal: 2 });
  api.action.getBadgeText = async () => '2';
  expect((await read('distinct')).passed).toBe(true);
  for (const item of state.reviewHistory) item.latestSeen = '2026-10-01T00:00:01.000Z';
  expect((await read('repeat')).passed).toBe(true);
  state.reviewHistory[1].id = 'f_wrong';
  expect((await read('repeat')).passed).toBe(false);
  state.reviewHistory[1].id = 'f_' + hash([finding.origin, finding.opaqueFingerprint, 2]);
  state.reviewHistory[1].ordinal = 3;
  expect((await read('repeat')).passed).toBe(false);
  state.reviewHistory[1].ordinal = 2;
  state.reviewHistory.push({ ...finding, id: 'overflow', ordinal: 3 });
  expect((await read('repeat')).passed).toBe(false);
  state.reviewHistory.pop();
  expect((await read('before-exit')).passed).toBe(true);
  api.action.getBadgeText = async () => '';
  expect((await read('exit')).passed).toBe(true);
  finding.latestSeen = '2026-10-01T00:00:02.000Z';
  expect((await read('exit')).passed).toBe(false);
  state.reviewHistory = [{}];
  await expect(read('repeat')).rejects.toThrow('schema');
  expect(Object.values(host).every((v) => typeof v === 'number' || /^[a-f0-9]{64}$/.test(v))).toBe(true);
});

const results = () => Object.fromEntries(WORKFLOW_PREDICATES.map((name) => [name, name === 'accessibility' ? true : 'passed']));

test('synthetic final readbacks preserve exact source, subscriptions, retention and revoked generation through restart', async () => {
  const { state, finding, confirmed } = crudFixture();
  const origin = finding.origin;
  finding.firstSeen = finding.latestSeen = new Date().toISOString();
  finding.status = 'reviewed'; state.subscriptions = [confirmed];
  state.grantState = { version: 1, sites: { [origin]: { enabled: false, generation: 2 } } };
  const api = cleanApi(state);
  const url = 'chrome-extension://' + 'a'.repeat(32) + '/worker.js';
  api.runtime = { id: 'a'.repeat(32), getURL: () => url };
  api.permissions.contains = async () => false;
  const read = (mode, base) => observeFinalState(api, mode, origin, url, base, validate);
  const baseline = await read('baseline');
  expect(Object.values(baseline).every((v) => typeof v === 'number' || /^[a-f0-9]{64}$/.test(v))).toBe(true);
  expect(await read('retention', baseline)).toBe(false);
  state.retentionPolicy = 7;
  expect(await read('retention', baseline)).toBe(true);
  const after = { ...baseline, policy: 7 };
  expect(await read('unchanged', after)).toBe(true);
  for (const key of ['history', 'subscriptions', 'rest']) expect(await read('unchanged', { ...after, [key]: '0'.repeat(64) })).toBe(false);
  const good = structuredClone(state);
  for (const mutation of [() => { finding.status = 'needs-review'; }, () => { state.subscriptions.push({ ...confirmed, id: 'extra' }); }, () => { state.retentionPolicy = 30; }, () => { state.grantState.sites[origin].generation++; }]) {
    mutation(); expect(await read('unchanged', after)).toBe(false);
    Object.assign(state, structuredClone(good));
  }
  for (const malformed of [{ retentionPolicy: 999 }, { reviewHistory: [{}] }, { subscriptions: [{}] }]) {
    Object.assign(state, good, malformed); await expect(read('unchanged', after)).rejects.toThrow('schema');
  }
  Object.assign(state, good); api.runtime.id = 'b'.repeat(32);
  await expect(read('unchanged', after)).rejects.toThrow('identity');
});

test('production pure catalog rejects actual runner port origin; help DOM observes NONE, not a fabricated fallback', async () => {
  const { build } = await import('esbuild');
  const { fixtureOriginForServerAddress } = await import('../scripts/manual-active-tab-qa.mjs');
  const { JSDOM } = await import('jsdom');
  const bundle = await build({ entryPoints: ['src/shared/guide-catalog.ts'], bundle: true, write: false, format: 'iife', globalName: 'QaCatalog' });
  const resolveGuide = runInNewContext(`${bundle.outputFiles[0].text}; QaCatalog.resolveCancellationGuide`, { URL });
  const origin = fixtureOriginForServerAddress({ address: '127.0.0.1', port: 49152 });
  expect(resolveGuide(origin).kind).toBe('none');
  // Isolated catalog control ONLY: this is not the browser's actual origin.
  expect(resolveGuide('https://checkout-a.test')).toMatchObject({ kind: 'site', originURL: 'https://checkout-a.test' });
  const help = resolveGuide(origin);
  const dom = new JSDOM(`<select data-review-retention><option value="7" selected>7 days</option></select><section aria-label="Subscriptions"><p>Delete removes the local record only; it does not cancel billing.</p><div data-subscription-list><article><div role="status"></div></article></div></section>`);
  const status = dom.window.document.querySelector('[role="status"]');
  if (help.kind === 'none') status.textContent = 'No known provider site; check your billing provider';
  const observe = runInNewContext(`(${observeFinalUi.toString()})`, { document: dom.window.document, URL });
  expect(observe('help', origin)).toBe(true);
  status.textContent = 'Loading cancellation help…';
  expect(observe('help', origin)).toBe(false);
  status.textContent = 'No known provider site; check your billing provider';
  status.innerHTML += `<a href="${origin}/">Visit site — not a cancellation guide</a>`;
  expect(observe('help', origin)).toBe(false);
  status.querySelector('a').remove();
  expect(observe('help', 'https://checkout-a.test')).toBe(false);
  dom.window.document.querySelector('[data-subscription-list]').append(dom.window.document.createElement('article'));
  expect(observe('help', origin)).toBe(false);
});

test('final stages require explicit restart authorization and fail on persisted-state mismatch', async () => {
  for (const failure of ['none', 'authorization', 'restart']) {
    let restarted = false;
    let acknowledgements = 0;
    const instructions = [];
    const run = runFinalCheckpoints({ instruct: (text) => instructions.push(text), acknowledge: async () => ++acknowledgements === 3 && failure === 'authorization' ? '' : 'DONE',
      read: async () => !(restarted && failure === 'restart'), ui: async () => true, integrity: async () => {},
      restart: async () => { restarted = true; }, quiet: async () => true });
    if (failure === 'none') await expect(run).resolves.toBeUndefined();
    else await expect(run).rejects.toThrow(failure === 'authorization' ? 'authorization' : 'durability');
    const helpInstruction = instructions.find((text) => text.startsWith('31.'));
    expect(helpInstruction).toContain('HELP NEGATIVE BOUNDARY');
    expect(helpInstruction).toContain('NO anchor');
    expect(helpInstruction).toContain('positive Visit site fallback and official guides remain UNVERIFIED');
    expect(restarted).toBe(failure !== 'authorization');
  }
  // Final attestation is now gated by complete explicit results and fresh binding.
});

test('marker constructor cannot manufacture passed workflow results', () => {
  expect(() => createManualActiveTabQaMarker(candidate)).toThrow();
  // A negative mock boundary is not the complete cancellationHelp criterion.
  expect(() => createManualActiveTabQaMarker(candidate, { ...results(), cancellationHelp: 'unverified' })).toThrow();
  for (const name of WORKFLOW_PREDICATES) {
    const incomplete = results();
    delete incomplete[name];
    expect(() => createManualActiveTabQaMarker(candidate, incomplete)).toThrow();
  }
  expect(() => createManualActiveTabQaMarker(candidate, { ...results(), url: 'https://fixture.test' })).toThrow();
  expect(createManualActiveTabQaMarker(candidate, results()).schemaVersion).toBe(5);
});

test('stage does not advance until the observation and explicit acknowledgement both pass', async () => {
  let observe;
  let acknowledge;
  const events = [];
  const run = runHumanStage({
    instruction: 'Perform one action.',
    instruct: (text) => events.push(text),
    observe: () => new Promise((resolve) => { observe = resolve; }),
    acknowledge: () => new Promise((resolve) => { events.push('ack'); acknowledge = resolve; }),
  });
  await Promise.resolve();
  expect(events).toEqual(['Perform one action.']);
  observe(true);
  await Promise.resolve();
  expect(events).toEqual(['Perform one action.', 'ack']);
  acknowledge('DONE');
  await expect(run).resolves.toBe(true);
});

test('a rejected observation or acknowledgement cannot pass a stage', async () => {
  for (const [observed, ack] of [[false, 'DONE'], [true, ''], [true, 'ATTEST']]) {
    await expect(runHumanStage({ instruction: 'Act.', instruct: () => {}, observe: async () => observed, acknowledge: async () => ack })).rejects.toThrow();
  }
});
