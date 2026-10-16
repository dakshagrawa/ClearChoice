import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const listeners: Array<(message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean | undefined> = [];
const permissionRemoved: Array<(permissions: chrome.permissions.Permissions) => void> = [];
const registeredScripts: chrome.scripting.RegisteredContentScript[] = [];
const grantedOrigins = new Set<string>();
const getRegisteredContentScripts = vi.fn(async (filter?: { ids?: string[] }) => registeredScripts.filter((script) => !filter?.ids || filter.ids.includes(script.id)));
const registerContentScripts = vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => { registeredScripts.push(...scripts); });
const unregisterContentScripts = vi.fn(async ({ ids }: { ids: string[] }) => { for (const id of ids) { const index = registeredScripts.findIndex((script) => script.id === id); if (index >= 0) registeredScripts.splice(index, 1); } });
const permissionRequest = vi.fn<() => Promise<boolean>>();
const activated: Array<(info: chrome.tabs.TabActiveInfo) => void> = [];
const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins.every((origin) => grantedOrigins.has(origin)));
const state: Record<string, unknown> = {};
const sessionState: Record<string, unknown> = {};
const setAccessLevel = vi.fn().mockResolvedValue(undefined);
const sessionAccessLevel = vi.fn().mockResolvedValue(undefined);
const sessionGet = vi.fn().mockImplementation(async (key: string | null) => key === null ? { ...sessionState } : ({ [key]: sessionState[key] }));
const sessionSet = vi.fn().mockImplementation(async (value: Record<string, unknown>) => { Object.assign(sessionState, value); });
const sessionRemove = vi.fn().mockImplementation(async (key: string) => { delete sessionState[key]; });
const updated: Array<(tabId: number, change: chrome.tabs.TabChangeInfo) => void> = [];
const removedTabs: Array<(tabId: number) => void> = [];
const badgeText = vi.fn<(details: { tabId: number; text: string }) => Promise<void>>().mockResolvedValue(undefined);
const query = vi.fn().mockResolvedValue([{ id: 42 }]);
const tabGet = vi.fn().mockResolvedValue({ id: 42, url: 'https://merchant.test/checkout' });
const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, documentId: 'doc-A', result: undefined }]);
const sendMessage = vi.fn().mockImplementation(async (_tab: number, message: { type: string }) => message.type === 'CLEARCHOICE_AUTO_START'
  ? { ok: true } : { ok: true, status: 'unsupported-context', findingCount: 0 });
const get = vi.fn().mockImplementation(async () => ({ ...state }));
const set = vi.fn().mockImplementation(async (value: Record<string, unknown>) => { Object.assign(state, value); });
const popup = { id: 'extension', url: 'chrome-extension://extension/popup/index.html' } as chrome.runtime.MessageSender;
const content = { id: 'extension', tab: { id: 42 }, frameId: 0, documentId: 'doc-A', url: 'https://merchant.test/checkout' } as chrome.runtime.MessageSender;

async function boot() {
  vi.stubGlobal('chrome', { runtime: { id: 'extension', onMessage: { addListener: (fn: typeof listeners[number]) => listeners.push(fn) } }, tabs: { onActivated: { addListener: (fn: typeof activated[number]) => activated.push(fn) }, query, get: tabGet, sendMessage, onUpdated: { addListener: (fn: typeof updated[number]) => updated.push(fn) }, onRemoved: { addListener: (fn: typeof removedTabs[number]) => removedTabs.push(fn) } }, action: { setBadgeText: badgeText }, permissions: { request: permissionRequest, contains, onRemoved: { addListener: (fn: typeof permissionRemoved[number]) => permissionRemoved.push(fn) } }, scripting: { executeScript, getRegisteredContentScripts, registerContentScripts, unregisterContentScripts }, storage: { local: { setAccessLevel, get, set }, session: { setAccessLevel: sessionAccessLevel, get: sessionGet, set: sessionSet, remove: sessionRemove } } });
  await import('./index');
  await vi.waitFor(() => expect(listeners).toHaveLength(1));
  await new Promise<void>((resolve) => { listeners[0]({ type: 'INVALID' }, popup, () => resolve()); });
}
async function dispatch(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return new Promise((resolve) => { const accepted = listeners[0](message, sender, resolve); if (!accepted) resolve(undefined); });
}

it('resolves help only from the exact retained source across all 500 records', async () => {
  seedHistory(500);
  const history = state.reviewHistory as Array<{ id: string; origin: string }>;
  history[499].origin = 'https://netflix.com';
  await boot();
  const fields = { merchant: 'Unrelated label', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  const created = await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', version: 1, id: history[499].id, fields }, popup) as { subscription: { id: string } };
  const request = { type: 'CLEARCHOICE_SUBSCRIPTION_HELP', version: 1, id: created.subscription.id };
  expect(await dispatch(request, popup)).toMatchObject({ ...request, help: { kind: 'guide', destination: 'https://help.netflix.com/en/node/407', lastReviewed: '2026-09-29' } });
  expect(executeScript).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
});

it.each(['deleted', 'expired', 'manual', 'missing-subscription', 'wrong-sender'])('help fails closed for %s provenance without borrowing another finding', async (mode) => {
  seedHistory(2);
  const history = state.reviewHistory as Array<{ id: string; origin: string; latestSeen: string; firstSeen: string }>;
  history[0].origin = 'https://spotify.com'; history[1].origin = 'https://netflix.com';
  await boot();
  const fields = { merchant: 'Netflix', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  const created = await dispatch({ type: mode === 'manual' ? 'CLEARCHOICE_SUBSCRIPTION_CREATE' : 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', version: 1, ...(mode === 'manual' ? {} : { id: history[0].id }), fields }, popup) as { subscription: { id: string } };
  if (mode === 'deleted') state.reviewHistory = [history[1]];
  if (mode === 'expired') { history[0].firstSeen = history[0].latestSeen = '2020-01-01T00:00:00.000Z'; state.retentionPolicy = 30; }
  if (mode === 'missing-subscription') state.subscriptions = [];
  const request = { type: 'CLEARCHOICE_SUBSCRIPTION_HELP', version: 1, id: created.subscription.id };
  expect(await dispatch(request, mode === 'wrong-sender' ? content : popup)).toEqual(mode === 'missing-subscription' || mode === 'wrong-sender' ? { ok: false, error: 'request-failed' } : { ...request, help: { kind: 'none' } });
  expect(executeScript).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
  for (const change of [{ id: undefined }, { id: 'not found' }, { version: 2 }, { origin: 'https://netflix.com' }]) expect(await dispatch({ ...request, ...change }, popup)).toEqual({ ok: false, error: 'request-failed' });
});

it('creates a manual subscription with worker identity and lists it after worker recreation', async () => {
  seedHistory(1);
  await boot();
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly', notes: 'Family plan', nextBillingDate: '2026-10-01' };
  const response = await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_CREATE', version: 1, fields }, popup) as { type: string; version: number; subscription: { id: string; createdAt: string; updatedAt: string } };
  expect(response).toMatchObject({ type: 'CLEARCHOICE_SUBSCRIPTION_CREATE', version: 1, subscription: fields });
  expect(response.subscription.id).toMatch(/^s_[a-f0-9]{32}$/);
  expect(response.subscription.createdAt).toBe(response.subscription.updatedAt);
  expect(response.subscription).not.toHaveProperty('sourceFindingId');
  expect(state.reviewHistory).toHaveLength(1);
  listeners.length = 0;
  vi.resetModules();
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1 }, popup)).toEqual({ type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1, subscriptions: [response.subscription] });
  expect(executeScript).not.toHaveBeenCalled();
});

it('updates manual fields without replacing identity, creation time or other local state', async () => {
  seedHistory(1);
  await boot();
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly', notes: 'Old note' };
  const created = await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_CREATE', version: 1, fields }, popup) as { subscription: import('../shared/models').Subscription };
  const before = structuredClone(state);
  const updatedFields = { merchant: 'New merchant', amount: '20.00', currency: 'EUR', cadence: 'custom', customDescription: 'Every six weeks' };
  const result = await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_UPDATE', version: 1, id: created.subscription.id, fields: updatedFields }, popup);
  expect(result).toMatchObject({ type: 'CLEARCHOICE_SUBSCRIPTION_UPDATE', version: 1, subscription: { ...updatedFields, id: created.subscription.id, createdAt: created.subscription.createdAt } });
  expect((state.subscriptions as object[])[0]).not.toHaveProperty('notes');
  expect(state.reviewHistory).toEqual(before.reviewHistory);
  expect(state.receipts).toEqual(before.receipts);
  expect(state.retentionPolicy).toBe(before.retentionPolicy);
});

it('deletes only the explicitly selected subscription and rejects a second deletion', async () => {
  seedHistory(1);
  await boot();
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  const created = await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_CREATE', version: 1, fields }, popup) as { subscription: { id: string } };
  const other = await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_CREATE', version: 1, fields }, popup) as { subscription: object };
  expect(await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_DELETE', version: 1, id: created.subscription.id }, popup)).toEqual({ type: 'CLEARCHOICE_SUBSCRIPTION_DELETE', version: 1, id: created.subscription.id });
  expect(state.subscriptions).toEqual([other.subscription]);
  expect(state.reviewHistory).toHaveLength(1);
  expect(await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_DELETE', version: 1, id: created.subscription.id }, popup)).toEqual({ ok: false, error: 'request-failed' });
});

it('rejects forged manual fields and non-popup requests without changing local records', async () => {
  seedHistory(1);
  await boot();
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  const created = await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_CREATE', version: 1, fields }, popup) as { subscription: { id: string } };
  const snapshot = structuredClone(state);
  for (const changed of [{ amount: '10' }, { amount: '0.00' }, { nextBillingDate: '2026-02-30' }, { currency: 'usd' }, { notes: 'account number 123456789' }, { notes: 'https://private.test' }, { createdAt: '2026-01-01T00:00:00.000Z' }, { sourceFindingId: 'f_1' }, { notes: undefined }, { cadence: 'custom' }]) {
    for (const type of ['CLEARCHOICE_SUBSCRIPTION_CREATE', 'CLEARCHOICE_SUBSCRIPTION_UPDATE']) {
      const request = { type, version: 1, fields: { ...fields, ...changed }, ...(type.endsWith('UPDATE') ? { id: created.subscription.id } : {}) };
      expect(await dispatch(request, popup)).toEqual({ ok: false, error: 'request-failed' });
    }
  }
  for (const request of [
    { type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1 },
    { type: 'CLEARCHOICE_SUBSCRIPTION_CREATE', version: 1, fields },
    { type: 'CLEARCHOICE_SUBSCRIPTION_UPDATE', version: 1, id: created.subscription.id, fields },
    { type: 'CLEARCHOICE_SUBSCRIPTION_DELETE', version: 1, id: created.subscription.id },
  ]) {
    for (const sender of [content, { ...popup, url: `${popup.url}?fake=1` }, { ...popup, id: 'other' }])
      expect(await dispatch(request, sender)).toEqual({ ok: false, error: 'request-failed' });
    expect(await dispatch({ ...request, version: 2 }, popup)).toEqual({ ok: false, error: 'request-failed' });
    expect(await dispatch({ ...request, extra: 'private' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  }
  expect(state).toEqual(snapshot);
});

it('confirms a retained reviewed observation only through explicit Save and preserves provenance after restart and edit', async () => {
  seedHistory(2); await boot();
  const history = structuredClone(state.reviewHistory);
  expect(state.subscriptions).toEqual([]);
  const id = (state.reviewHistory as Array<{ id: string }>)[1].id;
  const fields = { merchant: 'User named merchant', amount: '12.00', currency: 'EUR', cadence: 'yearly' };
  const result = await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', version: 1, id, fields }, popup) as { subscription: import('../shared/models').Subscription };
  expect(result).toMatchObject({ type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', subscription: { ...fields, sourceFindingId: id } });
  expect(state.reviewHistory).toEqual(history);
  listeners.length = 0; vi.resetModules(); await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1 }, popup)).toMatchObject({ subscriptions: [result.subscription] });
  expect(await dispatch({ type: 'CLEARCHOICE_SUBSCRIPTION_UPDATE', version: 1, id: result.subscription.id, fields: { ...fields, merchant: 'Edited' } }, popup)).toMatchObject({ subscription: { sourceFindingId: id, merchant: 'Edited' } });
});

it('does not double-write when confirmation is retried for the same finding', async () => {
  seedHistory(1); await boot();
  const id = (state.reviewHistory as Array<{ id: string }>)[0].id;
  const request = { type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', version: 1, id, fields: { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' } };
  await dispatch(request, popup);
  const snapshot = structuredClone(state); const writes = set.mock.calls.length;
  expect(await dispatch(request, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(state).toEqual(snapshot); expect(set).toHaveBeenCalledTimes(writes);
});

it('rejects missing, expired, deleted, forged, surplus, unsafe and non-popup confirmation without mutation', async () => {
  seedHistory(1); await boot();
  const id = (state.reviewHistory as Array<{ id: string }>)[0].id;
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  const request = { type: 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING', version: 1, id, fields };
  const snapshot = structuredClone(state); const writes = set.mock.calls.length;
  for (const invalid of [{ ...request, id: 'f_missing' }, { ...request, id: undefined }, { ...request, version: 2 }, { ...request, extra: true }, { ...request, fields: { ...fields, sourceFindingId: id } }, { ...request, fields: { ...fields, notes: 'https://private.test' } }, { ...request, fields: { ...fields, amount: '0.00' } }])
    expect(await dispatch(invalid, popup)).toEqual({ ok: false, error: 'request-failed' });
  for (const sender of [content, { ...popup, id: 'other' }, { ...popup, url: `${popup.url}?fake` }]) expect(await dispatch(request, sender)).toEqual({ ok: false, error: 'request-failed' });
  expect(state).toEqual(snapshot); expect(set).toHaveBeenCalledTimes(writes);
  state.retentionPolicy = 7;
  (state.reviewHistory as Array<{ latestSeen: string; firstSeen: string }>)[0].latestSeen = '2020-01-01T00:00:00.000Z';
  (state.reviewHistory as Array<{ latestSeen: string; firstSeen: string }>)[0].firstSeen = '2020-01-01T00:00:00.000Z';
  const expired = structuredClone(state);
  expect(await dispatch(request, popup)).toEqual({ ok: false, error: 'request-failed' }); expect(state).toEqual(expired);
  state.reviewHistory = []; const deleted = structuredClone(state);
  expect(await dispatch(request, popup)).toEqual({ ok: false, error: 'request-failed' }); expect(state).toEqual(deleted);
  state.reviewHistory = snapshot.reviewHistory; state.retentionPolicy = 'never';
  set.mockRejectedValueOnce(new Error('quota'));
  expect(await dispatch(request, popup)).toEqual({ ok: false, error: 'request-failed' }); expect(state).toEqual(snapshot);
});

function seedHistory(count: number) {
  const instant = new Date().toISOString();
  state.version = 1;
  state.subscriptions = [];
  state.retentionPolicy = 'never';
  state.reviewHistory = Array.from({ length: count }, (_, index) => {
    const screenedExcerpt = `Monthly plan $10.00 item ${index}`;
    return { id: `f_${index.toString(16).padStart(64, '0')}`, origin: 'https://merchant.test',
      kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt,
      opaqueFingerprint: createHash('sha256').update(`recurring-charge\0price-cadence\0${screenedExcerpt}`).digest('hex'),
      ordinal: 1, firstSeen: instant, latestSeen: instant,
      status: index % 2 ? 'reviewed' : 'needs-review' };
  });
}

it.each([101, 500])('pages all %i retained records with stable identities and global count', async (count) => {
  seedHistory(count);
  await boot();
  const collected: Array<{ id: string; status: string }> = [];
  for (let offset = 0; offset < count; offset += 100) {
    const response = await dispatch({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset, limit: 100 }, popup) as {
      type: string; version: number; offset: number; total: number; needsReviewCount: number;
      retentionPolicy: string; findings: Array<{ id: string; status: string }>;
    };
    expect(response).toMatchObject({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1,
      offset, total: count, needsReviewCount: Math.ceil(count / 2), retentionPolicy: 'never' });
    expect(response.findings.length).toBe(Math.min(100, count - offset));
    expect(JSON.stringify(response)).not.toContain('opaqueFingerprint');
    collected.push(...response.findings);
  }
  expect(collected).toHaveLength(count);
  expect(new Set(collected.map((item) => item.id)).size).toBe(count);
  expect(collected[0].id).toBe(`f_${'0'.repeat(64)}`);
  expect(collected[0].status).toBe('needs-review');
  expect(await dispatch({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: count, limit: 100 }, popup))
    .toMatchObject({ findings: [], total: count });
});

it('limits history reads and mutations to exact popup sender and request shapes', async () => {
  seedHistory(1);
  await boot();
  const id = (state.reviewHistory as Array<{ id: string }>)[0].id;
  for (const request of [
    { type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 0, limit: 100 },
    { type: 'CLEARCHOICE_REVIEW_MARK', version: 1, id },
    { type: 'CLEARCHOICE_REVIEW_DELETE', version: 1, id },
    { type: 'CLEARCHOICE_REVIEW_RETENTION', version: 1, policy: 7 },
  ]) {
    expect(await dispatch(request, content)).toEqual({ ok: false, error: 'request-failed' });
    expect(await dispatch(request, { ...popup, url: 'chrome-extension://extension/options.html' }))
      .toEqual({ ok: false, error: 'request-failed' });
    expect(await dispatch({ ...request, url: '/checkout' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  }
  expect(set.mock.calls.filter(([value]) => 'reviewHistory' in value)).toHaveLength(0);
});

it('marks, deletes and changes retention only after queued storage commits', async () => {
  seedHistory(2);
  await boot();
  const id = (state.reviewHistory as Array<{ id: string }>)[0].id;
  let release!: () => void;
  set.mockImplementationOnce(async (value: Record<string, unknown>) => {
    await new Promise<void>((resolve) => { release = resolve; });
    Object.assign(state, value);
  });
  const pending = dispatch({ type: 'CLEARCHOICE_REVIEW_MARK', version: 1, id }, popup);
  await vi.waitFor(() => expect(release).toBeDefined());
  const queued = dispatch({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 0, limit: 10 }, popup);
  release();
  expect(await pending).toEqual({ ok: true });
  expect(await queued).toMatchObject({ needsReviewCount: 0, findings: [expect.objectContaining({ id, status: 'reviewed' }), expect.anything()] });
  expect(await dispatch({ type: 'CLEARCHOICE_REVIEW_DELETE', version: 1, id }, popup)).toEqual({ ok: true });
  expect(await dispatch({ type: 'CLEARCHOICE_REVIEW_RETENTION', version: 1, policy: 7 }, popup)).toEqual({ ok: true });
  expect(await dispatch({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 0, limit: 10 }, popup))
    .toMatchObject({ total: 1, needsReviewCount: 0, retentionPolicy: 7 });
  expect(await dispatch({ type: 'CLEARCHOICE_REVIEW_MARK', version: 1, id }, popup))
    .toEqual({ ok: false, error: 'request-failed' });
  set.mockRejectedValueOnce(new Error('quota'));
  expect(await dispatch({ type: 'CLEARCHOICE_REVIEW_RETENTION', version: 1, policy: 90 }, popup))
    .toEqual({ ok: false, error: 'request-failed' });
  expect(state.retentionPolicy).toBe(7);
});

it('orders by latestSeen then ID and excludes expired records from count and pages', async () => {
  seedHistory(3);
  const history = state.reviewHistory as Array<{ id: string; latestSeen: string; status: string }>;
  history[2].latestSeen = new Date(Date.now() - 31 * 86_400_000).toISOString();
  history[0].latestSeen = new Date(Date.now() - 60_000).toISOString();
  history[1].latestSeen = new Date(Date.now() - 60_000).toISOString();
  // firstSeen may not exceed latestSeen in persisted records.
  for (const entry of history) (entry as typeof entry & { firstSeen: string }).firstSeen = entry.latestSeen;
  state.retentionPolicy = 30;
  await boot();
  const page = await dispatch({ type: 'CLEARCHOICE_REVIEW_LIST', version: 1, offset: 0, limit: 2 }, popup) as {
    total: number; needsReviewCount: number; findings: Array<{ id: string }>;
  };
  expect(page).toMatchObject({ total: 2, needsReviewCount: 1 });
  expect(page.findings.map((item) => item.id)).toEqual([history[0].id, history[1].id]);
  expect(state.reviewHistory).toHaveLength(2);
});

it('does not acknowledge failed mark or deletion and leaves stored history unchanged', async () => {
  seedHistory(1);
  await boot();
  const id = (state.reviewHistory as Array<{ id: string }>)[0].id;
  set.mockRejectedValueOnce(new Error('quota'));
  expect(await dispatch({ type: 'CLEARCHOICE_REVIEW_MARK', version: 1, id }, popup))
    .toEqual({ ok: false, error: 'request-failed' });
  expect((state.reviewHistory as Array<{ status: string }>)[0].status).toBe('needs-review');
  set.mockRejectedValueOnce(new Error('quota'));
  expect(await dispatch({ type: 'CLEARCHOICE_REVIEW_DELETE', version: 1, id }, popup))
    .toEqual({ ok: false, error: 'request-failed' });
  expect(state.reviewHistory).toHaveLength(1);
});
afterEach(() => { permissionRequest.mockReset(); activated.length = 0; updated.length = 0; removedTabs.length = 0; listeners.length = 0; permissionRemoved.length = 0; registeredScripts.length = 0; grantedOrigins.clear(); for (const key of Object.keys(state)) delete state[key]; for (const key of Object.keys(sessionState)) delete sessionState[key]; vi.clearAllMocks(); get.mockReset().mockImplementation(async () => ({ ...state })); sendMessage.mockReset().mockImplementation(async (_tab: number, message: { type: string }) => message.type === 'CLEARCHOICE_AUTO_START' ? { ok: true } : { ok: true, status: 'unsupported-context', findingCount: 0 }); query.mockReset().mockResolvedValue([{ id: 42 }]); tabGet.mockReset().mockResolvedValue({ id: 42, url: 'https://merchant.test/checkout' }); vi.resetModules(); vi.unstubAllGlobals(); });

const autoBatch = (requestId = 'auto-1') => {
  const screenedExcerpt = 'Monthly plan $10.00';
  const opaqueFingerprint = createHash('sha256').update(`recurring-charge\0price-cadence\0${screenedExcerpt}`).digest('hex');
  return { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId,
    findings: [{ version: 1, requestId, kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt, opaqueFingerprint, ordinal: 1 }] };
};
const autoRequest = (generation = 1) => ({ type: 'CLEARCHOICE_AUTO_SUBMIT', version: 1, generation, batch: autoBatch() });
async function enabledAuto() {
  grantedOrigins.add('https://merchant.test/*');
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup)).toEqual({ ok: true, enabled: true, permitted: true });
  sendMessage.mockImplementation(async (_tab: number, challenge: { requestId: string; nonce: string }) => ({
    type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce,
  }));
}

it('allows dismissal state for an opted-in automatic document even when its tab is backgrounded, but not after revoke', async () => {
  await enabledAuto();
  query.mockResolvedValue([{ id: 7 }]);
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_GET' }, content))
    .toEqual({ ok: true, dismissed: false });
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: true }, content))
    .toEqual({ ok: true });
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_GET' }, content))
    .toEqual({ ok: true, dismissed: true });
  grantedOrigins.clear();
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_GET' }, content))
    .toEqual({ ok: false, error: 'request-failed' });
});

it('returns a generation only to a live top-frame document on a permitted registered site', async () => {
  await enabledAuto();
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: true, generation: 1 });
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, { ...content, frameId: 1 }))
    .toEqual({ ok: false, error: 'request-failed' });
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, { ...content, url: 'https://other.test/checkout' }))
    .toEqual({ ok: false, error: 'request-failed' });
  tabGet.mockResolvedValueOnce({ id: 42, url: 'https://other.test/checkout' });
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content))
    .toEqual({ ok: false, error: 'request-failed' });
  grantedOrigins.clear();
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content))
    .toEqual({ ok: false, error: 'request-failed' });
});

const emptyStatus = (status = 'supported-zero', generation = 1) => ({ type: 'CLEARCHOICE_AUTO_DOCUMENT_STATUS', version: 1, generation, requestId: 'status-1', status });

it.each(['supported-zero', 'unsupported-context', 'unavailable-overflow'])('clears %s only with a current-frame and exact-document live challenge', async (status) => {
  await enabledAuto();
  await dispatch(autoRequest(), content);
  badgeText.mockClear();
  // Bootstrap must not enqueue behind this challenge, even during beforeCommit.
  sendMessage.mockImplementation(async (_tab: number, challenge: { nonce: string; requestId: string }) => {
    expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: true, generation: 1 });
    return { type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce };
  });
  expect(await dispatch(emptyStatus(status), content)).toEqual({ ok: true });
  expect(badgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '' });
  expect(sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({ requestId: 'status-1' }), { frameId: 0 });
  expect(sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({ requestId: 'status-1' }), { documentId: 'doc-A' });
});

it.each(['status', 'overflow', 'submit'])('rejects an old same-origin document %s even if its exact target still replies', async (kind) => {
  await enabledAuto();
  await dispatch(autoRequest(), content);
  badgeText.mockClear();
  sendMessage.mockImplementation(async (_tab: number, challenge: { nonce: string; requestId: string }, target: { frameId?: number }) => target.frameId === 0
    ? { ok: false, error: 'request-failed' }
    : { type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce });
  expect(await dispatch(kind === 'overflow' ? emptyStatus('unavailable-overflow') : kind === 'status' ? emptyStatus() : autoRequest(), content)).toEqual({ ok: false, error: 'request-failed' });
  expect(badgeText).not.toHaveBeenCalled();
});

it.each([
  { ...content, tab: { id: 7 } }, { ...content, frameId: 1 }, { ...content, id: 'spoof' }, { ...content, documentId: undefined }, { ...content, url: 'https://b.test/path' },
])('rejects an unauthorized status sender %#', async (sender) => {
  await enabledAuto();
  expect(await dispatch(emptyStatus(), sender as chrome.runtime.MessageSender)).toEqual({ ok: false, error: 'request-failed' });
  expect(await dispatch(emptyStatus('unavailable-overflow'), sender as chrome.runtime.MessageSender)).toEqual({ ok: false, error: 'request-failed' });
  expect(badgeText).not.toHaveBeenCalled();
});

it.each([{ version: 2 }, { generation: 2 }, { findingCount: 0 }, { evidence: 'private' }, { requestId: '' }])('rejects malformed or stale overflow status %# without clearing an accepted badge', async (changed) => {
  await enabledAuto();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
  badgeText.mockClear();
  expect(await dispatch({ ...emptyStatus('unavailable-overflow'), ...changed }, content)).toEqual({ ok: false, error: 'request-failed' });
  expect(badgeText).not.toHaveBeenCalled();
});

it('rejects overflow status with a spoofed challenge nonce without clearing an accepted badge', async () => {
  await enabledAuto();
  await dispatch(autoRequest(), content);
  badgeText.mockClear();
  sendMessage.mockImplementation(async (_tab: number, challenge: { requestId: string }) => ({
    type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: 'spoofed-nonce',
  }));
  expect(await dispatch(emptyStatus('unavailable-overflow'), content)).toEqual({ ok: false, error: 'request-failed' });
  expect(badgeText).not.toHaveBeenCalled();
});

it.each(['overflow', 'revoke', 'permission'])('keeps a concurrent site B badge intact when A clears by %s', async (operation) => {
  await enabledAuto();
  const bOrigin = 'https://b.test';
  const bContent = { ...content, tab: { id: 7 }, documentId: 'doc-B', url: `${bOrigin}/checkout` } as chrome.runtime.MessageSender;
  grantedOrigins.add(`${bOrigin}/*`);
  query.mockResolvedValue([{ id: 7, url: `${bOrigin}/checkout` }]);
  tabGet.mockImplementation(async (tabId: number) => ({ id: tabId, url: tabId === 7 ? `${bOrigin}/checkout` : 'https://merchant.test/checkout' }));
  sendMessage.mockImplementation(async (_tab: number, challenge: { type: string; requestId: string; nonce: string }) => challenge.type === 'CLEARCHOICE_AUTO_START'
    ? { ok: true } : { type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce });
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: bOrigin }, popup)).toMatchObject({ ok: true });
  expect(await dispatch(autoRequest(), content)).toMatchObject({ ok: true });
  expect(await dispatch({ ...autoRequest(), batch: autoBatch('b-scan') }, bContent)).toMatchObject({ ok: true });
  badgeText.mockClear();
  const historyBefore = structuredClone(state);
  if (operation === 'overflow') {
    expect(await dispatch(emptyStatus('unavailable-overflow'), content)).toEqual({ ok: true });
    expect(state).toEqual(historyBefore);
  } else if (operation === 'permission') {
    grantedOrigins.delete('https://merchant.test/*');
    permissionRemoved[0]({ origins: ['https://merchant.test/*'] });
  } else {
    query.mockResolvedValue([{ id: 42, url: 'https://merchant.test/checkout' }]);
    expect(await dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup)).toMatchObject({ ok: true, enabled: false });
  }
  await vi.waitFor(() => expect(badgeText).toHaveBeenCalledWith({ tabId: 42, text: '' }));
  expect(badgeText.mock.calls.some(([value]) => value.tabId === 7)).toBe(false);
  expect(sessionState['clearchoice.badge.7']).toMatchObject({ documentId: 'doc-B', generation: 1 });
});

it('navigation clears immediately even while an automatic challenge is blocked', async () => {
  await enabledAuto();
  await dispatch(autoRequest(), content);
  let finish!: (reply: unknown) => void;
  sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const delayed = dispatch({ ...autoRequest(), batch: autoBatch('delayed') }, content);
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(updated).toHaveLength(1);
  updated[0](42, { status: 'loading' });
  await vi.waitFor(() => expect(badgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '' }));
  expect(sessionState['clearchoice.badge.42']).toBeUndefined();
  const challenge = sendMessage.mock.calls.at(-1)![1];
  finish({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce });
  expect(await delayed).toEqual({ ok: false, error: 'request-failed' });
  expect(badgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '' });
  expect(removedTabs).toHaveLength(1);
  removedTabs[0](42);
  await vi.waitFor(() => expect(sessionRemove).toHaveBeenCalledWith('clearchoice.document.42'));
});

it.each(['status', 'overflow', 'submit'])('revocation rejects delayed old-generation %s and cannot restore its badge', async (kind) => {
  await enabledAuto();
  await dispatch(autoRequest(), content);
  let finish!: (reply: unknown) => void;
  sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const delayed = dispatch(kind === 'overflow' ? emptyStatus('unavailable-overflow') : kind === 'status' ? emptyStatus() : { ...autoRequest(), batch: autoBatch('delayed') }, content);
  await vi.waitFor(() => expect(finish).toBeDefined());
  const challenge = sendMessage.mock.calls.at(-1)![1];
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup)).toMatchObject({ ok: true, enabled: false });
  finish({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce });
  expect(await delayed).toEqual({ ok: false, error: 'request-failed' });
  expect(badgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '' });
  badgeText.mockClear();
  expect(await dispatch(emptyStatus(), content)).toEqual({ ok: false, error: 'request-failed' });
  expect(badgeText).not.toHaveBeenCalled();
});

it('manual activeTab analysis sets accepted count without a host grant and clears unsupported', async () => {
  await boot();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch: autoBatch(challenge.requestId) }, content)).toEqual({ ok: true, findingCount: 1 });
    return { ok: true, status: 'supported', findingCount: 1 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: true, status: 'supported', findingCount: 1 });
  expect(badgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '1' });
  expect(grantedOrigins.size).toBe(0);
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: true, status: 'unsupported-context', findingCount: 0 });
  expect(badgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '' });
});

it('places revoke clearing after a concurrently delayed browser badge set', async () => {
  await enabledAuto();
  let finish!: () => void;
  badgeText.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const submitting = dispatch(autoRequest(), content);
  await vi.waitFor(() => expect(finish).toBeDefined());
  const revoked = dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup);
  // Allow the popup's focus/origin checkpoints to retire the badge capture.
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish();
  expect(await submitting).toEqual({ ok: false, error: 'request-failed' });
  expect(await revoked).toMatchObject({ ok: true, enabled: false });
  expect(badgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '' });
  expect(sessionState['clearchoice.badge.42']).toBeUndefined();
});

it('classifies status operational failures as retryable without a success badge', async () => {
  await enabledAuto();
  sessionSet.mockRejectedValueOnce(new Error('temporary session failure'));
  expect(await dispatch(emptyStatus(), content)).toEqual({ ok: false, error: 'retryable-failure' });
  expect(badgeText).not.toHaveBeenCalled();
  expect(await dispatch(emptyStatus(), content)).toEqual({ ok: true });
});

it('automatic pre-write challenges can reenter generation bootstrap without queue deadlock', async () => {
  await enabledAuto();
  sendMessage.mockImplementation(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: true, generation: 1 });
    return { type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce };
  });
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
});

it('sets a badge only from accepted persisted automatic findings', async () => {
  await enabledAuto();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
  expect(badgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '1' });
  expect(sessionState['clearchoice.badge.42']).toEqual({ documentId: 'doc-A', generation: 1, origin: 'https://merchant.test' });
  badgeText.mockClear();
  set.mockRejectedValueOnce(new Error('quota'));
  expect(await dispatch({ ...autoRequest(), batch: autoBatch('new-request') }, content)).toEqual({ ok: false, error: 'retryable-failure' });
  expect(badgeText).not.toHaveBeenCalled();
});

it('challenges the exact automatic top document and persists only a count acknowledgement', async () => {
  await enabledAuto();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
  expect(sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE', version: 1, requestId: 'auto-1' }), { documentId: 'doc-A' });
  expect(state.reviewHistory).toEqual([expect.objectContaining({ origin: 'https://merchant.test', screenedExcerpt: 'Monthly plan $10.00' })]);
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
  expect(state.reviewHistory).toHaveLength(1);
  expect(JSON.stringify(sendMessage.mock.calls)).not.toContain('/checkout');
});

it.each([
  ['other document', { ...content, documentId: 'doc-B' }],
  ['subframe', { ...content, frameId: 1 }],
  ['other tab', { ...content, tab: { id: 7 } }],
  ['other origin', { ...content, url: 'https://other.test/checkout' }],
  ['missing document', { ...content, documentId: undefined }],
  ['untrusted extension', { ...content, id: 'other' }],
])('rejects automatic sender %s without a receipt', async (_label, forged) => {
  await enabledAuto();
  if (_label === 'other document') sendMessage.mockRejectedValueOnce(new Error('No receiving document'));
  expect(await dispatch(autoRequest(), forged as chrome.runtime.MessageSender)).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it.each(['wrong nonce', 'wrong request', 'surplus', 'failed target'])('rejects %s challenge without history', async (failure) => {
  await enabledAuto();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { nonce: string; requestId: string }) => {
    if (failure === 'failed target') throw new Error('No receiving document');
    return { type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1,
      requestId: failure === 'wrong request' ? 'other' : challenge.requestId,
      nonce: failure === 'wrong nonce' ? 'other' : challenge.nonce,
      ...(failure === 'surplus' ? { evidence: 'private' } : {}) };
  });
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it('recovers initialization in the same worker after transient trusted-storage setup errors', async () => {
  setAccessLevel.mockRejectedValueOnce(new Error('temporary setup error'));
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: 'https://merchant.test' }, popup))
    .toEqual({ ok: true, enabled: false, permitted: false });
  expect(setAccessLevel).toHaveBeenCalledTimes(2);
});

it('classifies a false semantic fingerprint as nonretryable without persisting it', async () => {
  await enabledAuto();
  const altered = autoRequest();
  altered.batch.findings[0].opaqueFingerprint = 'a'.repeat(64);
  expect(await dispatch(altered, content)).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it('classifies a request ID collision as nonretryable without rewriting history', async () => {
  await enabledAuto();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
  const prior = structuredClone(state);
  const collision = autoRequest();
  collision.batch.findings[0].ordinal = 2;
  expect(await dispatch(collision, content)).toEqual({ ok: false, error: 'request-failed' });
  expect(state).toEqual(prior);
});

it('reports exhausted review capacity as nonretryable without a partial 501st record', async () => {
  await enabledAuto();
  const requestFor = (group: number) => {
    const requestId = `auto-cap-${group}`;
    const findings = Array.from({ length: 100 }, (_, index) => {
      const screenedExcerpt = `Monthly plan $10.00 item ${group}-${index}`;
      return { version: 1, requestId, kind: 'recurring-charge', reason: 'price-cadence',
        screenedExcerpt, opaqueFingerprint: createHash('sha256').update(`recurring-charge\0price-cadence\0${screenedExcerpt}`).digest('hex'), ordinal: 1 };
    });
    return { type: 'CLEARCHOICE_AUTO_SUBMIT', version: 1, generation: 1,
      batch: { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId, findings } };
  };
  for (let group = 0; group < 5; group++) {
    expect(await dispatch(requestFor(group), content)).toEqual({ ok: true, findingCount: 100 });
  }
  const prior = structuredClone(state);
  expect(await dispatch(requestFor(5), content)).toEqual({ ok: false, error: 'request-failed' });
  expect(state).toEqual(prior);
  expect(state.reviewHistory).toHaveLength(500);
});

it('reports a transient initial grant checkpoint read failure as retryable without writing', async () => {
  await enabledAuto();
  get.mockRejectedValueOnce(new Error('temporary grant storage failure'));
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: false, error: 'retryable-failure' });
  expect(sendMessage.mock.calls.filter(([, message]) => message.type === 'CLEARCHOICE_FINDINGS_CHALLENGE')).toHaveLength(0);
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
});

it('identifies an unavailable worker initialization as retryable only for a valid automatic sender', async () => {
  grantedOrigins.add('https://merchant.test/*');
  setAccessLevel.mockRejectedValueOnce(new Error('temporary storage setup error'))
    .mockRejectedValueOnce(new Error('temporary storage setup error'))
    .mockRejectedValueOnce(new Error('temporary storage setup error'));
  await boot();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: false, error: 'retryable-failure' });
  expect(await dispatch(autoRequest(), { ...content, id: 'other' })).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it('rejects an in-flight automatic submission after an explicit popup revoke', async () => {
  await enabledAuto();
  let finishChallenge!: (reply: unknown) => void;
  sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishChallenge = resolve; }));
  const pending = dispatch(autoRequest(), content);
  await vi.waitFor(() => expect(finishChallenge).toBeDefined());
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup))
    .toMatchObject({ ok: true, enabled: false });
  const first = sendMessage.mock.calls.find(([, message]) => message.type === 'CLEARCHOICE_FINDINGS_CHALLENGE')![1];
  finishChallenge({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: first.requestId, nonce: first.nonce });
  expect(await pending).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
  expect(state.reviewHistory).toEqual([]);
});

it('reports an interrupted history write as retryable without partial receipt or acknowledgement', async () => {
  await enabledAuto();
  const prior = structuredClone(state);
  set.mockRejectedValueOnce(new Error('temporary storage failure'));
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: false, error: 'retryable-failure' });
  expect(state).toEqual(prior);
  expect(state.reviewHistory).toEqual([]);
  expect(state.receipts).toBeUndefined();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
});

it('rejects a stale automatic generation and revoked permission', async () => {
  await enabledAuto();
  expect(await dispatch(autoRequest(2), content)).toEqual({ ok: false, error: 'request-failed' });
  grantedOrigins.clear();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it('refuses a receipt replay when permission disappears during the second challenge', async () => {
  await enabledAuto();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
  const writes = set.mock.calls.filter(([value]) => 'receipts' in value).length;
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { nonce: string; requestId: string }) => {
    grantedOrigins.clear();
    return { type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce };
  });
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(writes);
});

it('vetoes automatic commit when permission disappears during challenge', async () => {
  await enabledAuto();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { nonce: string; requestId: string }) => {
    grantedOrigins.clear();
    return { type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: challenge.requestId, nonce: challenge.nonce };
  });
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it('vetoes automatic receipt replay when permission disappears during the queued storage read', async () => {
  await enabledAuto();
  expect(await dispatch(autoRequest(), content)).toEqual({ ok: true, findingCount: 1 });
  let release!: () => void;
  get.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { ...state }; });
  const result = dispatch(autoRequest(), content);
  await vi.waitFor(() => expect(release).toBeDefined());
  grantedOrigins.clear();
  release();
  expect(await result).toEqual({ ok: false, error: 'request-failed' });
});

it('rejects a same-origin document replacement at the queued checkpoint', async () => {
  await enabledAuto();
  let release!: () => void;
  get.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { ...state }; });
  const result = dispatch(autoRequest(), content);
  await vi.waitFor(() => expect(release).toBeDefined());
  sendMessage.mockRejectedValueOnce(new Error('No receiving document'));
  release();
  expect(await result).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it('vetoes automatic commit after a document navigation during the queued storage read', async () => {
  await enabledAuto();
  let release!: () => void;
  get.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { ...state }; });
  const result = dispatch(autoRequest(), content);
  await vi.waitFor(() => expect(release).toBeDefined());
  tabGet.mockResolvedValue({ id: 42, url: 'https://other.test/checkout' });
  release();
  expect(await result).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it('fails closed before enable-now injection when focus changes during top-document probe', async () => {
  grantedOrigins.add('https://merchant.test/*');
  await boot();
  let release!: (value: chrome.scripting.InjectionResult[]) => void;
  executeScript.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup);
  await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(1));
  query.mockResolvedValue([{ id: 7 }]);
  release([{ frameId: 0, documentId: 'doc-A' }]);
  expect(await pending).toEqual({ ok: false, error: 'request-failed' });
  expect(executeScript).toHaveBeenCalledTimes(1);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(registeredScripts).toHaveLength(0);
  expect((state.grantState as { sites: Record<string, { enabled: boolean }> }).sites['https://merchant.test'].enabled).toBe(false);
});

it('never widens a missing document target to tab-wide injection', async () => {
  grantedOrigins.add('https://merchant.test/*');
  await boot();
  executeScript.mockResolvedValueOnce([{ frameId: 1, documentId: 'other' }]);
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup))
    .toEqual({ ok: false, error: 'request-failed' });
  expect(executeScript).toHaveBeenCalledTimes(1);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: false, error: 'request-failed' });
  expect(registeredScripts).toHaveLength(0);
  expect((state.grantState as { sites: Record<string, { enabled: boolean }> }).sites['https://merchant.test'].enabled).toBe(false);
  expect(grantedOrigins.has('https://merchant.test/*')).toBe(true);
});

it('preserves a previously enabled grant when its immediate bootstrap fails', async () => {
  await enabledAuto();
  executeScript.mockRejectedValueOnce(new Error('probe unavailable'));
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup))
    .toEqual({ ok: true, enabled: true, permitted: true });
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: true, generation: 1 });
});

it('reports unsafe rollback if both persistence and registration cleanup fail', async () => {
  grantedOrigins.add('https://merchant.test/*');
  await boot();
  executeScript.mockRejectedValueOnce(new Error('probe unavailable'));
  set.mockImplementationOnce(async (value: Record<string, unknown>) => { Object.assign(state, value); });
  set.mockRejectedValueOnce(new Error('disk failure'));
  unregisterContentScripts.mockRejectedValueOnce(new Error('unregister failure'));
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup))
    .toEqual({ ok: false, error: 'revocation-unsafe' });
  expect(registeredScripts).toHaveLength(1);
});

it('re-enables the same document at a new generation after a missed disable', async () => {
  await enabledAuto();
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: true, generation: 1 });
  sendMessage.mockRejectedValueOnce(new Error('exact document did not receive disable'));
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup))
    .toEqual({ ok: true, enabled: false, permitted: true });
  sendMessage.mockResolvedValue({ ok: true });
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup))
    .toEqual({ ok: true, enabled: true, permitted: true });
  expect(sendMessage).toHaveBeenCalledWith(42, { type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 3 }, { documentId: 'doc-A' });
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: true, generation: 3 });
  expect(await dispatch(autoRequest(1), content)).toEqual({ ok: false, error: 'request-failed' });
});

it('revokes a recorded automatic document even when tab URL is unavailable, without touching B', async () => {
  await enabledAuto();
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: true, generation: 1 });
  expect(sessionState['clearchoice.automatic.42']).toEqual({ tabId: 42, documentId: 'doc-A', origin: 'https://merchant.test' });
  sessionState['clearchoice.automatic.7'] = { tabId: 7, documentId: 'doc-B', origin: 'https://b.test' };
  tabGet.mockResolvedValue({ id: 42 });
  // Restore a visible active A only for the popup request, then lose the URL during cleanup.
  tabGet.mockResolvedValueOnce({ id: 42, url: 'https://merchant.test/checkout' })
    .mockResolvedValueOnce({ id: 42, url: 'https://merchant.test/checkout' });
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup))
    .toMatchObject({ ok: false });
  expect(sendMessage).toHaveBeenCalledWith(42, { type: 'CLEARCHOICE_DISABLE' }, { documentId: 'doc-A' });
  expect(sendMessage).not.toHaveBeenCalledWith(7, expect.anything(), expect.anything());
  expect(sessionState['clearchoice.automatic.42']).toBeUndefined();
  expect(sessionState['clearchoice.automatic.7']).toEqual({ tabId: 7, documentId: 'doc-B', origin: 'https://b.test' });
});

it('authorizes exact active popup site before enabling; never registers on spoof or missing permission', async () => {
  await boot();
  const enable = { type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' };
  expect(await dispatch(enable, { ...popup, url: 'chrome-extension://extension/other.html' })).toEqual({ ok: false, error: 'request-failed' });
  expect(await dispatch(enable, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(registeredScripts).toHaveLength(0);
  grantedOrigins.add('https://merchant.test/*');
  expect(await dispatch(enable, popup)).toEqual({ ok: true, enabled: true, permitted: true });
  expect(registeredScripts).toEqual([expect.objectContaining({ matches: ['https://merchant.test/*'], allFrames: false })]);
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: 'https://merchant.test' }, popup)).toEqual({ ok: true, enabled: true, permitted: true });
  expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 42 }, func: expect.any(Function) });
  expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 42, documentIds: ['doc-A'] }, files: ['content.js'] });
  expect(sendMessage).toHaveBeenCalledWith(42, { type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 1 }, { documentId: 'doc-A' });
  tabGet.mockResolvedValue({ id: 42, url: 'https://b.test/path' });
  expect(await dispatch(enable, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup)).toEqual({ ok: false, error: 'request-failed' });
});

it.each(['focus', 'navigation'])('rejects %s change during registration without saving a grant or leaving a script', async (change) => {
  grantedOrigins.add('https://merchant.test/*');
  await boot();
  let release!: () => void;
  registerContentScripts.mockImplementationOnce(async (scripts) => {
    registeredScripts.push(...scripts);
    await new Promise<void>((resolve) => { release = resolve; });
  });
  const pending = dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup);
  await vi.waitFor(() => expect(registerContentScripts).toHaveBeenCalledTimes(1));
  if (change === 'focus') query.mockResolvedValue([{ id: 7 }]);
  else tabGet.mockResolvedValue({ id: 42, url: 'https://other.test/path' });
  release();
  expect(await pending).toEqual({ ok: false, error: 'request-failed' });
  expect(registeredScripts).toHaveLength(0);
  expect((state.grantState as { sites?: Record<string, unknown> } | undefined)?.sites?.['https://merchant.test']).toBeUndefined();
  expect(set.mock.calls.filter(([value]) => 'grantState' in value)).toHaveLength(0);
  expect(set.mock.calls.filter(([value]) => 'receipts' in value)).toHaveLength(0);
});

it('revokes only the active site even when another site remains registered', async () => {
  grantedOrigins.add('https://merchant.test/*');
  grantedOrigins.add('https://b.test/*');
  state.grantState = { version: 1, sites: { 'https://b.test': { enabled: true, generation: 1 } } };
  registeredScripts.push({ id: `clearchoice-site-${createHash('sha256').update('https://b.test').digest('hex')}`, matches: ['https://b.test/*'], js: ['content.js'], allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' });
  await boot();
  await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup);
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup)).toEqual({ ok: true, enabled: false, permitted: true });
  expect(registeredScripts).toEqual([expect.objectContaining({ matches: ['https://b.test/*'] })]);
  expect((state.grantState as { sites: Record<string, { enabled: boolean }> }).sites['https://b.test'].enabled).toBe(true);
});

it('reports disabled status when registration is absent despite a stored enabled grant', async () => {
  grantedOrigins.add('https://merchant.test/*');
  await boot();
  await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup);
  registeredScripts.length = 0;
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: 'https://merchant.test' }, popup)).toEqual({ ok: true, enabled: false, permitted: true });
});

it('surfaces dual storage and unregister failures as unsafe revocation, without hiding B', async () => {
  grantedOrigins.add('https://merchant.test/*');
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_ENABLE', origin: 'https://merchant.test' }, popup)).toEqual({ ok: true, enabled: true, permitted: true });
  set.mockRejectedValueOnce(new Error('quota'));
  unregisterContentScripts.mockRejectedValueOnce(new Error('script failure'));
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: 'https://merchant.test' }, popup)).toEqual({ ok: false, error: 'revocation-unsafe' });
  expect(registeredScripts).toHaveLength(1);
});

it('reconciles stale enabled grants on startup and listens for permission removal without changing manual Analyze', async () => {
  state.grantState = { version: 1, sites: { 'https://a.test': { enabled: true, generation: 1 } } };
  await boot();
  await vi.waitFor(() => expect((state.grantState as { sites: Record<string, { generation: number }> }).sites['https://a.test'].generation).toBe(2));
  expect(permissionRemoved).toHaveLength(1);
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: true, status: 'unsupported-context', findingCount: 0 });
});

it('handles an external permission removal event for one enabled origin', async () => {
  const origin = 'https://a.test';
  const id = `clearchoice-site-${createHash('sha256').update(origin).digest('hex')}`;
  state.grantState = { version: 1, sites: { [origin]: { enabled: true, generation: 1 } } };
  registeredScripts.push({ id, matches: [`${origin}/*`], js: ['content.js'], allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' });
  grantedOrigins.add(`${origin}/*`);
  await boot();
  expect(permissionRemoved).toHaveLength(1);
  grantedOrigins.delete(`${origin}/*`);
  permissionRemoved[0]({ origins: [`${origin}/*`] });
  await vi.waitFor(() => expect((state.grantState as { sites: Record<string, { generation: number }> }).sites[origin].generation).toBe(2));
  expect(registeredScripts).toHaveLength(0);
});

it('coordinates a popup Analyze only after trusted-only storage initialization and targets the injected top document', async () => {
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: true, status: 'unsupported-context', findingCount: 0 });
  expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ['content.js'] });
  expect(sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({ type: 'CLEARCHOICE_ANALYZE' }), { documentId: 'doc-A' });
});

it('fails closed on storage access-level rejection without injecting or writing', async () => {
  setAccessLevel.mockRejectedValueOnce(new Error('denied')).mockRejectedValueOnce(new Error('denied'))
    .mockRejectedValueOnce(new Error('denied'));
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(executeScript).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});

it('accepts only a challenged top-frame batch from the same document and returns count only', async () => {
  await boot();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [] };
    for (const forged of [
      { ...content, documentId: 'doc-B' }, { ...content, frameId: 1 }, { ...content, tab: { id: 7 } },
    ]) {
      expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, forged as chrome.runtime.MessageSender)).toEqual({ ok: false, error: 'request-failed' });
    }
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch: { ...batch, findings: [{ evidence: 'raw' }] } }, content)).toEqual({ ok: false, error: 'request-failed' });
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch: { ...batch, findings: Array.from({ length: 101 }, () => ({ evidence: 'raw' })) } }, content)).toEqual({ ok: false, error: 'request-failed' });
    expect(set.mock.calls.filter(([payload]) => 'receipts' in payload)).toHaveLength(0);
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, content)).toEqual({ ok: true, findingCount: 0 });
    return { ok: true, status: 'supported', findingCount: 0 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: true, status: 'supported', findingCount: 0 });
  expect(state.reviewHistory).toEqual([]);
  expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: 'late', batch: { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: 'late', findings: [] } }, content)).toEqual({ ok: false, error: 'request-failed' });
});

it('rejects a content count that disagrees with the persisted screened batch', async () => {
  await boot();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [] };
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, content)).toEqual({ ok: true, findingCount: 0 });
    return { ok: true, status: 'supported', findingCount: 1 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(state.reviewHistory).toEqual([]);
});

it('persists a challenged screened finding while returning only count and status to popup', async () => {
  await boot();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    const screenedExcerpt = 'Monthly plan $10.00';
    const opaqueFingerprint = createHash('sha256').update(`recurring-charge\0price-cadence\0${screenedExcerpt}`).digest('hex');
    const finding = { version: 1, requestId: challenge.requestId, kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt, opaqueFingerprint, ordinal: 1 };
    const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [finding] };
    const receipt = await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, content);
    expect(receipt).toEqual({ ok: true, findingCount: 1 });
    return { ok: true, status: 'supported', findingCount: 1 };
  });
  const response = await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup);
  expect(response).toEqual({ ok: true, status: 'supported', findingCount: 1 });
  expect(JSON.stringify(response)).not.toContain('Monthly plan');
  expect(state.reviewHistory).toEqual([expect.objectContaining({ origin: 'https://merchant.test', screenedExcerpt: 'Monthly plan $10.00', status: 'needs-review' })]);
});

it('fails closed on corrupt dismissed storage during a challenged scan', async () => {
  await boot();
  state.dismissed = 'corrupt';
  let dismissal: unknown;
  sendMessage.mockImplementationOnce(async () => {
    dismissal = await dispatch({ type: 'CLEARCHOICE_DISMISSED_GET' }, content);
    return { ok: false, error: 'request-failed' };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(dismissal).toEqual({ ok: false, error: 'request-failed' });
});

it('allows a later dismissal only from the authenticated active document', async () => {
  await boot();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [] };
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, content)).toEqual({ ok: true, findingCount: 0 });
    expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_GET' }, content)).toEqual({ ok: true, dismissed: false });
    return { ok: true, status: 'supported', findingCount: 0 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: true, status: 'supported', findingCount: 0 });
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: true }, content)).toEqual({ ok: true });
  expect(state.dismissed).toBe(true);
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: false }, { ...content, documentId: 'doc-B' })).toEqual({ ok: false, error: 'request-failed' });
});

it('keeps an authenticated document dismissal after an MV3 worker restart', async () => {
  await boot();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [] };
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, content)).toEqual({ ok: true, findingCount: 0 });
    return { ok: true, status: 'supported', findingCount: 0 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: true, status: 'supported', findingCount: 0 });
  listeners.length = 0;
  vi.resetModules();
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: true }, content)).toEqual({ ok: true });
  expect(state.dismissed).toBe(true);
  for (const forged of [{ ...content, documentId: 'doc-B' }, { ...content, frameId: 1 }, { ...content, url: 'https://other.test/checkout' }]) {
    expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: false }, forged as chrome.runtime.MessageSender)).toEqual({ ok: false, error: 'request-failed' });
  }
  expect(state.dismissed).toBe(true);
  tabGet.mockResolvedValueOnce({ id: 42, url: 'https://other.test/checkout' });
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: false }, content)).toEqual({ ok: false, error: 'request-failed' });
  query.mockResolvedValueOnce([{ id: 7 }]);
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: false }, content)).toEqual({ ok: false, error: 'request-failed' });
  expect(state.dismissed).toBe(true);
});

it('fails closed if session access cannot be restricted before injection', async () => {
  sessionAccessLevel.mockRejectedValueOnce(new Error('denied')).mockRejectedValueOnce(new Error('denied'))
    .mockRejectedValueOnce(new Error('denied'));
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(executeScript).not.toHaveBeenCalled();
  expect(sessionSet).not.toHaveBeenCalled();
});

it('rejects a corrupted session grant after worker restart', async () => {
  sessionState['clearchoice.document.42'] = { tabId: 42, documentId: 'doc-A', origin: 'https://merchant.test', extra: 'unsafe' };
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: true }, content)).toEqual({ ok: false, error: 'request-failed' });
  expect(state.dismissed).toBeUndefined();
});

it('does not let a superseded Analyze response delete or borrow the newer challenge', async () => {
  await boot();
  let releaseA!: (value: unknown) => void;
  let releaseB!: () => void;
  const submit = (challenge: { requestId: string; nonce: string }) => dispatch({
    type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce,
    batch: { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [] },
  }, content);
  sendMessage.mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve; }));
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    await new Promise<void>((resolve) => { releaseB = resolve; });
    expect(await submit(challenge)).toEqual({ ok: true, findingCount: 0 });
    return { ok: true, status: 'supported', findingCount: 0 };
  });
  const a = dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  const b = dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  releaseA({ ok: true, status: 'supported', findingCount: 0 });
  expect(await a).toEqual({ ok: false, error: 'request-failed' });
  releaseB();
  expect(await b).toEqual({ ok: true, status: 'supported', findingCount: 0 });
  expect(state.reviewHistory).toEqual([]);
});

it('rejects a navigation-origin change while the challenged document submits', async () => {
  await boot();
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [] };
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, { ...content, url: 'https://other.test/checkout' })).toEqual({ ok: false, error: 'request-failed' });
    query.mockResolvedValueOnce([{ id: 7 }]);
    expect(await dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, content)).toEqual({ ok: false, error: 'request-failed' });
    return { ok: true, status: 'supported', findingCount: 0 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(set.mock.calls.filter(([payload]) => 'receipts' in payload)).toHaveLength(0);
});

it('does not commit a challenged finding when focus switches during the queued storage read', async () => {
  await boot();
  const snapshot = structuredClone(state);
  const writes = set.mock.calls.length;
  let releaseRead!: (value: Record<string, unknown>) => void;
  get.mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    const screenedExcerpt = 'Monthly plan $10.00';
    const opaqueFingerprint = createHash('sha256').update(`recurring-charge\0price-cadence\0${screenedExcerpt}`).digest('hex');
    const finding = { version: 1, requestId: challenge.requestId, kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt, opaqueFingerprint, ordinal: 1 };
    const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [finding] };
    const submission = dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, content);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    query.mockResolvedValue([{ id: 7 }]);
    releaseRead({ ...state });
    expect(await submission).toEqual({ ok: false, error: 'request-failed' });
    return { ok: true, status: 'supported', findingCount: 1 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(set).toHaveBeenCalledTimes(writes);
  expect(state).toEqual(snapshot);
});

it('does not commit a challenged finding when navigation changes during the queued storage read', async () => {
  await boot();
  const writes = set.mock.calls.length;
  let releaseRead!: (value: Record<string, unknown>) => void;
  get.mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
  sendMessage.mockImplementationOnce(async (_tab: number, challenge: { requestId: string; nonce: string }) => {
    const screenedExcerpt = 'Monthly plan $10.00';
    const opaqueFingerprint = createHash('sha256').update(`recurring-charge\0price-cadence\0${screenedExcerpt}`).digest('hex');
    const finding = { version: 1, requestId: challenge.requestId, kind: 'recurring-charge', reason: 'price-cadence', screenedExcerpt, opaqueFingerprint, ordinal: 1 };
    const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: challenge.requestId, findings: [finding] };
    const submission = dispatch({ type: 'CLEARCHOICE_SUBMIT', nonce: challenge.nonce, batch }, content);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    tabGet.mockResolvedValue({ id: 42, url: 'https://other.test/checkout' });
    releaseRead({ ...state });
    expect(await submission).toEqual({ ok: false, error: 'request-failed' });
    return { ok: true, status: 'supported', findingCount: 1 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(set).toHaveBeenCalledTimes(writes);
});

it.each(['Cannot access a PDF document.', 'The extensions gallery cannot be scripted.', 'script failed'])('reports restricted and generic injection failures without messaging: %s', async (reason) => {
  await boot();
  executeScript.mockRejectedValueOnce(new Error(reason));
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: reason === 'script failed' ? 'injection-failed' : 'restricted-page' });
  expect(sendMessage).not.toHaveBeenCalled();
});

it('does not inject when focus switches after the initial active-tab lookup', async () => {
  await boot();
  query.mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([{ id: 7 }]);
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(executeScript).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

it('does not message an injected document when focus switches while injection is unresolved', async () => {
  await boot();
  let releaseInjection!: (value: chrome.scripting.InjectionResult[]) => void;
  executeScript.mockImplementationOnce(() => new Promise((resolve) => { releaseInjection = resolve; }));
  const analysis = dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup);
  await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(1));
  query.mockResolvedValue([{ id: 7 }]);
  releaseInjection([{ frameId: 0, documentId: 'doc-A', result: undefined }]);
  expect(await analysis).toEqual({ ok: false, error: 'request-failed' });
  expect(sendMessage).not.toHaveBeenCalled();
});

it('rejects a switched tab and absent top-document injection result', async () => {
  await boot();
  executeScript.mockResolvedValueOnce([{ frameId: 1, documentId: 'other' }]);
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(sendMessage).not.toHaveBeenCalled();
  query.mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([{ id: 7 }]);
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(sendMessage).not.toHaveBeenCalled();
});

const ownedEnable = { type: 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION', origin: 'https://merchant.test', tabId: 42 };
it('requests synchronously and completes durable enable after the popup response channel closes (mocked lifecycle)', async () => {
  await boot();
  let allow!: (allowed: boolean) => void;
  permissionRequest.mockImplementation(() => new Promise((resolve) => { allow = resolve; }));
  const reply = vi.fn(() => { throw new Error('Popup closed'); });
  listeners[0](ownedEnable, popup, reply);
  expect(permissionRequest).toHaveBeenCalledExactlyOnceWith({ origins: ['https://merchant.test/*'] });
  expect(registerContentScripts).not.toHaveBeenCalled();
  grantedOrigins.add('https://merchant.test/*');
  allow(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true, enabled: true, permitted: true }));
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toEqual({ ok: true, enabled: true, permitted: true });
  expect(registerContentScripts).toHaveBeenCalledTimes(1);
});

it.each(['false', 'reject', 'throw'])('owned permission %s enables nothing even when contains is true', async (mode) => {
  await boot();
  grantedOrigins.add('https://merchant.test/*');
  permissionRequest.mockImplementation(() => {
    if (mode === 'throw') throw new Error('gesture refused');
    return mode === 'false' ? Promise.resolve(false) : Promise.reject(new Error('request refused'));
  });
  expect(await dispatch(ownedEnable, popup)).toEqual({ ok: false, error: mode === 'false' ? 'permission-denied' : 'request-failed' });
  expect(registerContentScripts).not.toHaveBeenCalled();
  expect(executeScript).not.toHaveBeenCalled();
});

it('accepts already-approved permission without needing an onAdded event', async () => {
  await boot();
  grantedOrigins.add('https://merchant.test/*');
  permissionRequest.mockResolvedValue(true);
  expect(await dispatch(ownedEnable, popup)).toEqual({ ok: true, enabled: true, permitted: true });
  expect(sendMessage).toHaveBeenCalledWith(42, { type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 1 }, { documentId: 'doc-A' });
});

it('rejects spoofed popup senders and malformed owned requests before requesting permission', async () => {
  await boot();
  for (const sender of [content, { ...popup, id: 'other' }, { ...popup, url: popup.url + '?fake' }, { ...popup, tab: { id: 42 } }])
    expect(await dispatch(ownedEnable, sender as chrome.runtime.MessageSender)).toEqual({ ok: false, error: 'request-failed' });
  for (const change of [{ tabId: -1 }, { tabId: 1.5 }, { tabId: '42' }, { tabId: undefined }, { origin: 'https://Merchant.test' }, { origin: 'https://merchant.test/' }, { origin: 'http://merchant.test' }, { origin: 'https://merchant.test/path' }, { extra: true }])
    expect(await dispatch({ ...ownedEnable, ...change }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(permissionRequest).not.toHaveBeenCalled();
});

it.each(['reload', 'away-back', 'activation', 'close', 'revoke', 'permission-removal', 'expiry'])('invalidates owned prompt synchronously on %s', async (event) => {
  await boot();
  let allow!: (allowed: boolean) => void;
  permissionRequest.mockImplementation(() => new Promise((resolve) => { allow = resolve; }));
  const result = dispatch(ownedEnable, popup);
  let revoke: Promise<unknown> | undefined;
  if (event === 'reload') updated[0](42, { status: 'loading' });
  if (event === 'away-back') { updated[0](42, { url: 'https://other.test' }); updated[0](42, { url: 'https://merchant.test' }); }
  if (event === 'activation') { activated[0]({ tabId: 7, windowId: 1 }); activated[0]({ tabId: 42, windowId: 1 }); }
  if (event === 'close') removedTabs[0](42);
  if (event === 'revoke') revoke = dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: ownedEnable.origin }, popup);
  if (event === 'permission-removal') permissionRemoved[0]({ origins: ['https://merchant.test/*'] });
  const now = Date.now();
  const clock = event === 'expiry' ? vi.spyOn(Date, 'now').mockReturnValue(now + 120_001) : undefined;
  grantedOrigins.add('https://merchant.test/*');
  allow(true);
  expect(await result).toEqual({ ok: false, error: 'operation-expired' });
  clock?.mockRestore();
  await revoke;
  expect(registerContentScripts).not.toHaveBeenCalled();
  expect(executeScript).not.toHaveBeenCalled();
});

it('supersedes an old prompt by operation identity and registers only the latest attempt', async () => {
  await boot();
  const allow: Array<(value: boolean) => void> = [];
  permissionRequest.mockImplementation(() => new Promise((resolve) => { allow.push(resolve); }));
  const old = dispatch(ownedEnable, popup);
  const latest = dispatch(ownedEnable, popup);
  grantedOrigins.add('https://merchant.test/*');
  allow[1](true);
  expect(await latest).toMatchObject({ ok: true });
  allow[0](true);
  expect(await old).toEqual({ ok: false, error: 'operation-expired' });
  expect(registerContentScripts).toHaveBeenCalledTimes(1);
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: true });
});

it.each(['registration', 'probe', 'injection', 'start'])('cancels owned enable on revoke during %s and rolls back its generation', async (stage) => {
  await boot();
  grantedOrigins.add('https://merchant.test/*'); permissionRequest.mockResolvedValue(true);
  let release!: () => void;
  const pause = () => new Promise<void>((resolve) => { release = resolve; });
  if (stage === 'registration') registerContentScripts.mockImplementationOnce(async (scripts) => { await pause(); registeredScripts.push(...scripts); });
  if (stage === 'probe') executeScript.mockImplementationOnce(async () => { await pause(); return [{ frameId: 0, documentId: 'doc-A' }]; });
  if (stage === 'injection') executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'doc-A' }]).mockImplementationOnce(async () => { await pause(); return []; });
  if (stage === 'start') sendMessage.mockImplementationOnce(async () => { await pause(); return { ok: true }; });
  const result = dispatch(ownedEnable, popup);
  await vi.waitFor(() => expect(release).toBeDefined());
  const revoked = dispatch({ type: 'CLEARCHOICE_SITE_REVOKE', origin: ownedEnable.origin }, popup);
  release();
  expect(await result).toMatchObject({ ok: false });
  await revoked;
  expect(registeredScripts).toHaveLength(0);
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: false });
});

it('does not infer consent from unrelated events or an approved permission at worker startup', async () => {
  grantedOrigins.add('https://merchant.test/*');
  await boot();
  permissionRemoved[0]({ origins: ['https://unrelated.test/*'] });
  updated[0](42, { status: 'complete' });
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: false, permitted: true });
  expect(registerContentScripts).not.toHaveBeenCalled();
  expect(permissionRequest).not.toHaveBeenCalled();
});

it('keeps a newer enable durable when a superseded bootstrap rolls back the same origin', async () => {
  await boot(); grantedOrigins.add('https://merchant.test/*'); permissionRequest.mockResolvedValue(true);
  let release!: () => void;
  executeScript.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return [{ frameId: 0, documentId: 'doc-A' }]; });
  const old = dispatch(ownedEnable, popup);
  await vi.waitFor(() => expect(release).toBeDefined());
  const latest = dispatch(ownedEnable, popup);
  // Give the newer operation a chance to encounter the old in-flight grant.
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  expect(await old).toMatchObject({ ok: false });
  expect(await latest).toEqual({ ok: true, enabled: true, permitted: true });
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: true });
});

it.each(['registration', 'storage', 'rollback'])('owned enable reports %s failure without claiming success', async (stage) => {
  await boot(); grantedOrigins.add('https://merchant.test/*'); permissionRequest.mockResolvedValue(true);
  if (stage === 'registration') registerContentScripts.mockRejectedValueOnce(new Error('registration failed'));
  if (stage === 'storage') set.mockRejectedValueOnce(new Error('write failed'));
  if (stage === 'rollback') {
    executeScript.mockRejectedValueOnce(new Error('probe failed'));
    set.mockImplementationOnce(async (value) => { Object.assign(state, value); }).mockRejectedValueOnce(new Error('rollback write failed'));
    unregisterContentScripts.mockRejectedValueOnce(new Error('rollback unregister failed'));
  }
  expect(await dispatch(ownedEnable, popup)).toEqual({ ok: false, error: stage === 'rollback' ? 'revocation-unsafe' : 'request-failed' });
  if (stage !== 'rollback') expect(registeredScripts).toHaveLength(0);
  expect(grantedOrigins.has('https://merchant.test/*')).toBe(true);
});

it.each(['probe', 'injection', 'start'])('rolls back owned enable on same-origin reload during %s', async (stage) => {
  await boot(); grantedOrigins.add('https://merchant.test/*'); permissionRequest.mockResolvedValue(true);
  let release!: () => void;
  const pause = () => new Promise<void>((resolve) => { release = resolve; });
  if (stage === 'probe') executeScript.mockImplementationOnce(async () => { await pause(); return [{ frameId: 0, documentId: 'doc-A' }]; });
  if (stage === 'injection') executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'doc-A' }]).mockImplementationOnce(async () => { await pause(); return []; });
  if (stage === 'start') sendMessage.mockImplementationOnce(async () => { await pause(); return { ok: true }; });
  const result = dispatch(ownedEnable, popup);
  await vi.waitFor(() => expect(release).toBeDefined());
  updated[0](42, { status: 'loading' }); release();
  expect(await result).toEqual({ ok: false, error: 'request-failed' });
  expect(registeredScripts).toHaveLength(0);
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: false });
});

it('bounds pending consent and evicts the oldest attempt without enabling it', async () => {
  await boot();
  const allow: Array<(value: boolean) => void> = [];
  permissionRequest.mockImplementation(() => new Promise((resolve) => { allow.push(resolve); }));
  const results = Array.from({ length: 33 }, (_, index) => dispatch({ ...ownedEnable, tabId: index + 1 }, popup));
  allow[0](true);
  expect(await results[0]).toEqual({ ok: false, error: 'operation-expired' });
  allow.slice(1).forEach((resolve) => resolve(false)); await Promise.all(results);
  expect(registerContentScripts).not.toHaveBeenCalled();
});

it('recreated worker does not replay abandoned consent even if browser permission remains (mocked termination)', async () => {
  await boot();
  permissionRequest.mockImplementation(() => new Promise(() => { /* Old worker is discarded, not resumed. */ }));
  listeners[0](ownedEnable, popup, vi.fn());
  expect(permissionRequest).toHaveBeenCalledTimes(1);
  grantedOrigins.add('https://merchant.test/*');
  listeners.length = 0; vi.resetModules(); await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: false, permitted: true });
  expect(registerContentScripts).not.toHaveBeenCalled();
  expect(state).not.toHaveProperty('pendingIntent');
  expect(sessionState).toEqual({});
});

it('independently checks exact permission and original active tab after a true result', async () => {
  await boot(); permissionRequest.mockResolvedValue(true);
  expect(await dispatch(ownedEnable, popup)).toEqual({ ok: false, error: 'operation-expired' });
  grantedOrigins.add('https://merchant.test/*');
  query.mockResolvedValue([{ id: 7 }]);
  expect(await dispatch(ownedEnable, popup)).toEqual({ ok: false, error: 'operation-expired' });
  query.mockResolvedValue([{ id: 42 }]); tabGet.mockResolvedValue({ id: 42, url: 'https://other.test' });
  expect(await dispatch(ownedEnable, popup)).toEqual({ ok: false, error: 'operation-expired' });
  expect(registerContentScripts).not.toHaveBeenCalled(); expect(executeScript).not.toHaveBeenCalled();
});

// Deliberately never resolve the discarded worker's probe: only durable state survives.
it.each([true, false])('retires unfinished persisted enable on worker recreation (reload=%s)', async (reload) => {
  await boot(); grantedOrigins.add('https://merchant.test/*'); permissionRequest.mockResolvedValue(true);
  let probing = false;
  executeScript.mockImplementationOnce(() => { probing = true; return new Promise(() => {}); });
  listeners[0](ownedEnable, popup, vi.fn());
  await vi.waitFor(() => expect(probing).toBe(true));
  expect(state.grantState).toMatchObject({ sites: { [ownedEnable.origin]: { enabled: true } } });
  if (reload) {
    updated[0](42, { status: 'loading' });
    // The paused probe cannot perform rollback; cancellation alone must veto scans.
    expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: false, error: 'request-failed' });
  }
  listeners.length = 0; activated.length = 0; updated.length = 0; removedTabs.length = 0; permissionRemoved.length = 0;
  for (const key of Object.keys(sessionState)) delete sessionState[key];
  vi.resetModules(); await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: false, permitted: true });
  expect(registeredScripts).toHaveLength(0);
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: false, error: 'request-failed' });
});

it('preserves a completed owned enable across worker recreation and failed redundant bootstrap', async () => {
  await boot(); grantedOrigins.add('https://merchant.test/*'); permissionRequest.mockResolvedValue(true);
  expect(await dispatch(ownedEnable, popup)).toMatchObject({ ok: true, enabled: true });
  const completed = structuredClone(state.grantState);
  listeners.length = 0; activated.length = 0; updated.length = 0; removedTabs.length = 0; permissionRemoved.length = 0;
  vi.resetModules(); await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: true });
  executeScript.mockRejectedValueOnce(new Error('probe failed'));
  expect(await dispatch(ownedEnable, popup)).toMatchObject({ ok: true, enabled: true });
  expect(state.grantState).toEqual(completed);
});

it('preserves prior completed consent when a redundant bootstrap worker is terminated', async () => {
  await boot(); grantedOrigins.add('https://merchant.test/*'); permissionRequest.mockResolvedValue(true);
  expect(await dispatch(ownedEnable, popup)).toMatchObject({ enabled: true });
  const completed = structuredClone(state.grantState);
  let probing = false;
  executeScript.mockImplementationOnce(() => { probing = true; return new Promise(() => {}); });
  listeners[0](ownedEnable, popup, vi.fn());
  await vi.waitFor(() => expect(probing).toBe(true));
  updated[0](42, { status: 'loading' });
  listeners.length = 0; activated.length = 0; updated.length = 0; removedTabs.length = 0; permissionRemoved.length = 0;
  vi.resetModules(); await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: true });
  expect(state.grantState).toEqual(completed);
  expect(registeredScripts).toHaveLength(1);
});

it.each(['loading', 'activation'])('rejects cancellation during the exact completion write (%s)', async (event) => {
  await boot(); grantedOrigins.add('https://merchant.test/*'); permissionRequest.mockResolvedValue(true);
  let release!: () => void;
  set.mockImplementation(async (value: Record<string, unknown>) => {
    const next = value.grantState as { sites?: Record<string, object> } | undefined;
    const previous = state.grantState as { sites?: Record<string, { provisional?: boolean }> } | undefined;
    const grant = next?.sites?.[ownedEnable.origin];
    if (previous?.sites?.[ownedEnable.origin]?.provisional === true && grant
      && Object.keys(grant).length === 2 && 'enabled' in grant && grant.enabled === true) {
      await new Promise<void>((resolve) => { release = resolve; });
    }
    Object.assign(state, structuredClone(value));
  });
  const result = dispatch(ownedEnable, popup);
  await vi.waitFor(() => expect(release).toBeDefined());
  if (event === 'loading') updated[0](42, { status: 'loading' });
  else activated[0]({ tabId: 7, windowId: 1 });
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: false, error: 'request-failed' });
  release();
  expect(await result).toEqual({ ok: false, error: 'request-failed' });
  expect(state.grantState).toMatchObject({ sites: { [ownedEnable.origin]: { enabled: false, generation: 2 } } });
  expect(registeredScripts).toHaveLength(0);
  expect(await dispatch({ type: 'CLEARCHOICE_AUTO_STATUS' }, content)).toEqual({ ok: false, error: 'request-failed' });
  listeners.length = 0; activated.length = 0; updated.length = 0; removedTabs.length = 0; permissionRemoved.length = 0;
  vi.resetModules(); await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_SITE_STATUS', origin: ownedEnable.origin }, popup)).toMatchObject({ enabled: false });
});
