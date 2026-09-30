import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CLEARCHOICE_FINDINGS_BATCH } from '../shared/messages';
import { createWorkerStore } from './store';

const semanticFingerprint = (kind: string, reason: string, excerpt: string) =>
  createHash('sha256').update(`${kind}\0${reason}\0${excerpt}`, 'utf8').digest('hex');
const fingerprint = semanticFingerprint('recurring-charge', 'price-cadence', 'Monthly plan $10.00');
const evidence = (requestId: string, screenedExcerpt: string, ordinal = 1) => ({
  version: 1 as const, requestId, kind: 'recurring-charge' as const,
  reason: 'price-cadence' as const, screenedExcerpt,
  opaqueFingerprint: semanticFingerprint('recurring-charge', 'price-cadence', screenedExcerpt), ordinal,
});
const finding = (requestId: string) => evidence(requestId, 'Monthly plan $10.00');
const batch = (requestId: string) => ({
  type: CLEARCHOICE_FINDINGS_BATCH, version: 1 as const, requestId, findings: [finding(requestId)],
});

function fakeStorage() {
  const data: Record<string, unknown> = {};
  const get = vi.fn(async () => structuredClone(data));
  const set = vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); });
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true, value: { storage: { local: { get, set } } },
  });
  return { data, get, set };
}

it('checks confirmation provenance inside the shared queue after queued deletion', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  const { ids: [id] } = await store.upsertFindings(batch('queue-source'), 'https://example.com');
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  let release!: () => void;
  storage.set.mockImplementationOnce(async (items) => { await new Promise<void>(resolve => { release = resolve; }); Object.assign(storage.data, structuredClone(items)); });
  const deletion = store.deleteFinding(id);
  await vi.waitFor(() => expect(release).toBeDefined());
  const confirmation = store.createSubscription(fields, id);
  const rejected = expect(confirmation).rejects.toThrow('Retained finding');
  release(); await deletion; await rejected;
  expect(storage.data.subscriptions).toEqual([]); expect(storage.data.reviewHistory).toEqual([]);
  await expect(store.createSubscription(fields)).resolves.toMatchObject(fields);
});

it('rejects a source at the exact retention boundary without pruning or writing history', async () => {
  const storage = fakeStorage();
  let instant = new Date('2026-09-22T12:00:00.000Z');
  const store = createWorkerStore({ now: () => instant });
  const { ids: [id] } = await store.upsertFindings(batch('expired-source'), 'https://example.com');
  storage.data.retentionPolicy = 7;
  instant = new Date('2026-09-29T12:00:00.000Z');
  const snapshot = structuredClone(storage.data); const writes = storage.set.mock.calls.length;
  await expect(store.createSubscription({ merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' }, id)).rejects.toThrow('Retained finding');
  expect(storage.data).toEqual(snapshot); expect(storage.set).toHaveBeenCalledTimes(writes);
});

it('serializes manual creates with a queued list and persists only subscriptions', async () => {
  const storage = fakeStorage();
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [], receipts: [], retentionPolicy: 'never' });
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  let release!: () => void;
  storage.set.mockImplementationOnce(async (items) => {
    await new Promise<void>((resolve) => { release = resolve; });
    Object.assign(storage.data, structuredClone(items));
  });
  const first = store.createSubscription(fields);
  await vi.waitFor(() => expect(release).toBeDefined());
  const second = store.createSubscription(fields);
  const list = store.listSubscriptions();
  expect(storage.get).toHaveBeenCalledTimes(1);
  release();
  const entries = await Promise.all([first, second]);
  expect(await list).toEqual(entries);
  expect(entries[0].id).not.toBe(entries[1].id);
  expect(storage.set.mock.calls.every(([payload]) => Object.keys(payload).join() === 'subscriptions')).toBe(true);
  expect(await createWorkerStore().listSubscriptions()).toEqual(entries);
});

it('failed manual writes never mutate persisted records and leave the queue usable', async () => {
  const storage = fakeStorage();
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [], receipts: [] });
  const store = createWorkerStore();
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  storage.set.mockRejectedValueOnce(new Error('quota'));
  await expect(store.createSubscription(fields)).rejects.toThrow('quota');
  expect(storage.data.subscriptions).toEqual([]);
  const entry = await store.createSubscription(fields);
  for (const operation of [() => store.updateSubscription(entry.id, { ...fields, amount: '20.00' }), () => store.deleteSubscription(entry.id)]) {
    const snapshot = structuredClone(storage.data);
    storage.set.mockRejectedValueOnce(new Error('quota'));
    await expect(operation()).rejects.toThrow('quota');
    expect(storage.data).toEqual(snapshot);
  }
  await expect(store.listSubscriptions()).resolves.toEqual([entry]);
});

it('rejects manual creation at capacity and clock rollback without partial replacement', async () => {
  const storage = fakeStorage();
  const instant = '2026-09-29T12:00:00.000Z';
  const fields = { merchant: 'Acme', amount: '10.00', currency: 'USD', cadence: 'monthly' };
  const subscriptions = Array.from({ length: 500 }, (_, index) => ({ ...fields, id: `s_${index}`, createdAt: instant, updatedAt: instant }));
  Object.assign(storage.data, { version: 1, subscriptions, reviewHistory: [], receipts: [] });
  const store = createWorkerStore({ now: () => new Date('2026-09-28T12:00:00.000Z') });
  await expect(store.createSubscription(fields)).rejects.toThrow('capacity');
  await expect(store.updateSubscription('s_0', fields)).rejects.toThrow('Clock');
  expect(storage.set).not.toHaveBeenCalled();
  expect(storage.data.subscriptions).toEqual(subscriptions);
});

it('rejects a changed excerpt under an existing fingerprint before reading or changing reviewed history', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  await store.upsertFindings(batch('req-1'), 'https://example.com');
  (storage.data.reviewHistory as Array<{ status: string }>)[0].status = 'reviewed';
  const snapshot = structuredClone(storage.data);
  const reads = storage.get.mock.calls.length;
  const writes = storage.set.mock.calls.length;
  for (const requestId of ['req-1', 'req-2']) {
    const forged = batch(requestId);
    forged.findings[0].screenedExcerpt = 'Annual plan $10.00';
    await expect(store.upsertFindings(forged, 'https://example.com')).rejects.toThrow('fingerprint');
  }
  expect(storage.get).toHaveBeenCalledTimes(reads);
  expect(storage.set).toHaveBeenCalledTimes(writes);
  expect(storage.data).toEqual(snapshot);
});

it('rejects a forged new record and an invalid member of a mixed batch before storage access', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  const forged = { ...evidence('req-new', 'Annual plan $10.00'), opaqueFingerprint: fingerprint };
  await expect(store.upsertFindings({ ...batch('req-new'), findings: [forged] }, 'https://example.com'))
    .rejects.toThrow('fingerprint');
  const mixed = { ...batch('req-mixed'), findings: [finding('req-mixed'), { ...forged, requestId: 'req-mixed' }] };
  await expect(store.upsertFindings(mixed, 'https://example.com')).rejects.toThrow('fingerprint');
  expect(storage.get).not.toHaveBeenCalled();
  expect(storage.set).not.toHaveBeenCalled();
  expect(storage.data).toEqual({});
});

it('accepts distinct evidence with its own fingerprint and replays the identical request without mutation', async () => {
  const storage = fakeStorage();
  const clock = vi.fn().mockReturnValueOnce(new Date('2026-09-28T12:00:00.000Z'))
    .mockReturnValueOnce(new Date('2026-09-29T12:00:00.000Z'));
  const store = createWorkerStore({ now: clock });
  const first = await store.upsertFindings(batch('req-1'), 'https://example.com');
  const distinct = { ...batch('req-2'), findings: [evidence('req-2', 'Annual plan $10.00')] };
  const second = await store.upsertFindings(distinct, 'https://example.com');
  expect(second.ids[0]).not.toBe(first.ids[0]);
  const snapshot = structuredClone(storage.data);
  const writes = storage.set.mock.calls.length;
  await expect(store.upsertFindings(distinct, 'https://example.com')).resolves.toEqual(second);
  expect(storage.set).toHaveBeenCalledTimes(writes);
  expect(storage.data).toEqual(snapshot);
  expect(clock).toHaveBeenCalledTimes(2);
});

it('a commit veto leaves history and receipts unchanged, including on an identical receipt replay', async () => {
  const storage = fakeStorage();
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [], receipts: [], retentionPolicy: 30 });
  const store = createWorkerStore();
  const beforeCommit = vi.fn(async () => false);
  const snapshot = structuredClone(storage.data);
  await expect(store.upsertFindings(batch('req-1'), 'https://example.com', beforeCommit))
    .rejects.toThrow('no longer authorized');
  expect(beforeCommit).toHaveBeenCalledTimes(1);
  expect(storage.data).toEqual(snapshot);
  expect(storage.set).not.toHaveBeenCalled();
  const first = await store.upsertFindings(batch('req-1'), 'https://example.com');
  const writes = storage.set.mock.calls.length;
  await expect(store.upsertFindings(batch('req-1'), 'https://example.com', beforeCommit))
    .rejects.toThrow('no longer authorized');
  expect(beforeCommit).toHaveBeenCalledTimes(2);
  expect(storage.set).toHaveBeenCalledTimes(writes);
  await expect(store.upsertFindings(batch('req-1'), 'https://example.com', async () => true)).resolves.toEqual(first);
});

it('writes history and receipt in exactly one payload on a versioned store', async () => {
  const storage = fakeStorage();
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [] });
  await createWorkerStore().upsertFindings(batch('req-1'), 'https://example.com');
  expect(storage.set).toHaveBeenCalledTimes(1);
  expect(Object.keys(storage.set.mock.calls[0][0]).sort()).toEqual(['receipts', 'reviewHistory']);
  expect(storage.data.reviewHistory).toHaveLength(1);
  expect(storage.data.receipts).toHaveLength(1);
});

it('a rejected atomic payload leaves versioned history and receipts untouched', async () => {
  const storage = fakeStorage();
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [], receipts: [] });
  storage.set.mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(createWorkerStore().upsertFindings(batch('req-1'), 'https://example.com'))
    .rejects.toThrow('quota exceeded');
  expect(storage.data.reviewHistory).toEqual([]);
  expect(storage.data.receipts).toEqual([]);
  expect(storage.set).toHaveBeenCalledTimes(1);
});

it('replays semantically identical DTOs independent of object key insertion order', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  const original = batch('req-1');
  const first = await store.upsertFindings(original, 'https://example.com');
  const reordered = { ...original, findings: [{
    ordinal: 1, opaqueFingerprint: fingerprint, screenedExcerpt: 'Monthly plan $10.00',
    reason: 'price-cadence', kind: 'recurring-charge', requestId: 'req-1', version: 1,
  }] };
  const writes = storage.set.mock.calls.length;
  await expect(store.upsertFindings(reordered, 'https://example.com')).resolves.toEqual(first);
  expect(storage.set).toHaveBeenCalledTimes(writes);
});

it('a new scan advances latestSeen but preserves firstSeen and reviewed status', async () => {
  const storage = fakeStorage();
  const clock = vi.fn().mockReturnValueOnce(new Date('2026-09-28T12:00:00.000Z'))
    .mockReturnValueOnce(new Date('2026-09-29T12:00:00.000Z'));
  const store = createWorkerStore({ now: clock });
  const first = await store.upsertFindings(batch('req-1'), 'https://example.com');
  (storage.data.reviewHistory as Array<{ status: string }>)[0].status = 'reviewed';
  const second = await store.upsertFindings(batch('req-2'), 'https://example.com');
  expect(second).toEqual(first);
  expect(storage.data.reviewHistory).toEqual([expect.objectContaining({
    firstSeen: '2026-09-28T12:00:00.000Z', latestSeen: '2026-09-29T12:00:00.000Z', status: 'reviewed',
  })]);
});

it('can review and delete an older persisted finding with a schema-valid nonhash ID', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  await store.upsertFindings(batch('legacy-seed'), 'https://example.com');
  (storage.data.reviewHistory as Array<{ id: string }>)[0].id = 'legacy';
  await store.markReviewed('legacy');
  expect((storage.data.reviewHistory as Array<{ status: string }>)[0].status).toBe('reviewed');
  await store.deleteFinding('legacy');
  expect(storage.data.reviewHistory).toEqual([]);
  await expect(store.markReviewed('../private')).rejects.toThrow('Invalid finding ID');
});

it('replays an acknowledged write after worker recreation without touching timestamps or storage', async () => {
  const storage = fakeStorage();
  const first = await createWorkerStore({ now: () => new Date('2026-09-28T12:00:00.000Z') })
    .upsertFindings(batch('req-1'), 'https://example.com');
  const snapshot = structuredClone(storage.data);
  const writes = storage.set.mock.calls.length;
  const replay = await createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') })
    .upsertFindings(batch('req-1'), 'https://example.com');
  expect(replay).toEqual(first);
  expect(storage.set).toHaveBeenCalledTimes(writes);
  expect(storage.data).toEqual(snapshot);
  expect((storage.data.reviewHistory as Array<{ firstSeen: string; latestSeen: string }>)).toHaveLength(1);
});

it('binds receipt digest to finding order', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  const two = { ...batch('req-1'), findings: [finding('req-1'), { ...finding('req-1'), ordinal: 2 }] };
  await store.upsertFindings(two, 'https://example.com');
  const snapshot = structuredClone(storage.data);
  await expect(store.upsertFindings({ ...two, findings: [...two.findings].reverse() }, 'https://example.com'))
    .rejects.toThrow('collision');
  expect(storage.data).toEqual(snapshot);
});

it('rejects request ID reuse with changed DTO, order, or origin without mutation', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  await store.upsertFindings(batch('req-1'), 'https://example.com');
  const snapshot = structuredClone(storage.data);
  const writes = storage.set.mock.calls.length;
  const changed = batch('req-1');
  changed.findings[0].screenedExcerpt = 'Annual plan $10.00';
  changed.findings[0].opaqueFingerprint = semanticFingerprint('recurring-charge', 'price-cadence', changed.findings[0].screenedExcerpt);
  await expect(store.upsertFindings(changed, 'https://example.com')).rejects.toThrow('collision');
  await expect(store.upsertFindings(batch('req-1'), 'https://other.example')).rejects.toThrow('collision');
  expect(storage.data).toEqual(snapshot);
  expect(storage.set).toHaveBeenCalledTimes(writes);
});

it('reports quota rejection on versioned storage and retries the same failed request without phantom success', async () => {
  const storage = fakeStorage();
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [], receipts: [] });
  const snapshot = structuredClone(storage.data);
  const store = createWorkerStore();
  storage.set.mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(store.upsertFindings(batch('req-1'), 'https://example.com')).rejects.toThrow('quota exceeded');
  expect(storage.data).toEqual(snapshot);
  const outcome = await store.upsertFindings(batch('req-1'), 'https://example.com');
  expect(outcome.ids).toHaveLength(1);
  expect(storage.set).toHaveBeenCalledTimes(2);
  expect(storage.data.reviewHistory).toHaveLength(1);
  expect(storage.data.receipts).toHaveLength(1);
});

it('rejects the entire malformed batch and duplicate semantic identities before writing', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  const invalid = batch('req-1');
  invalid.findings.push({ ...finding('req-1'), ordinal: 2, screenedExcerpt: 'account routing 123456789' });
  await expect(store.upsertFindings(invalid, 'https://example.com')).rejects.toThrow('Invalid findings batch');
  const duplicate = batch('req-1');
  duplicate.findings.push({ ...finding('req-1') });
  await expect(store.upsertFindings(duplicate, 'https://example.com')).rejects.toThrow('Duplicate finding identity');
  await expect(store.upsertFindings(batch('req-1'), 'https://example.com/path')).rejects.toThrow('origin');
  expect(storage.set).not.toHaveBeenCalled();
});

it('bounds receipt window to 500 while retaining stable finding upserts', async () => {
  const storage = fakeStorage();
  const ids = Array.from({ length: 500 }, (_, index) => ({
    requestId: `prior-${index}`, digest: 'b'.repeat(64), outcome: { ids: [] },
  }));
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [], receipts: ids });
  const store = createWorkerStore();
  await store.upsertFindings(batch('req-new'), 'https://example.com');
  const receipts = storage.data.receipts as Array<{ requestId: string }>;
  expect(receipts).toHaveLength(500);
  expect(receipts[0].requestId).toBe('prior-1');
  expect(receipts[499].requestId).toBe('req-new');
});

it('refuses corrupt receipts instead of replacing them', async () => {
  const storage = fakeStorage();
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [], receipts: [{ requestId: 'req-1', digest: 'bad', outcome: { ids: [] } }] });
  await expect(createWorkerStore().upsertFindings(batch('req-1'), 'https://example.com')).rejects.toThrow('Corrupt local receipts');
  expect(storage.set).not.toHaveBeenCalled();
});

it('refuses a forged valid-shape receipt with mismatched outcome IDs', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  await store.upsertFindings(batch('req-1'), 'https://example.com');
  const receipts = storage.data.receipts as Array<{ outcome: { ids: string[] } }>;
  receipts[0].outcome.ids = [`f_${'0'.repeat(64)}`];
  const snapshot = structuredClone(storage.data);
  await expect(store.upsertFindings(batch('req-1'), 'https://example.com')).rejects.toThrow('Corrupt receipt outcome');
  expect(storage.data).toEqual(snapshot);
});

it('serializes overlapping scans with one storage read per operation', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  const [first, second] = await Promise.all([
    store.upsertFindings(batch('req-1'), 'https://example.com'),
    store.upsertFindings(batch('req-2'), 'https://example.com'),
  ]);
  expect(first).toEqual(second);
  expect(storage.data.reviewHistory).toHaveLength(1);
  expect(storage.data.receipts).toHaveLength(2);
});

it('refuses history overflow without a partial receipt or second history write', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  const findings = Array.from({ length: 100 }, (_, index) => evidence('req-1', `Monthly plan $10.00 item ${index}`));
  for (let scan = 0; scan < 5; scan++) {
    await store.upsertFindings({ ...batch(`req-${scan}`), findings: findings.map((_, index) =>
      evidence(`req-${scan}`, `Monthly plan $10.00 item ${scan * 100 + index}`)) }, 'https://example.com');
  }
  const snapshot = structuredClone(storage.data);
  const writes = storage.set.mock.calls.length;
  await expect(store.upsertFindings({ ...batch('overflow'), findings: [evidence('overflow', 'Monthly plan $10.00 item 500')] }, 'https://example.com'))
    .rejects.toThrow('capacity');
  expect(storage.data).toEqual(snapshot);
  expect(storage.set).toHaveBeenCalledTimes(writes);
});

it('rejects invalid and backwards clocks before committing', async () => {
  const storage = fakeStorage();
  await expect(createWorkerStore({ now: () => new Date(NaN) }).upsertFindings(batch('req-1'), 'https://example.com'))
    .rejects.toThrow('clock');
  const store = createWorkerStore({ now: () => new Date('2026-09-28T12:00:00.000Z') });
  await store.upsertFindings(batch('req-1'), 'https://example.com');
  const snapshot = structuredClone(storage.data);
  await expect(createWorkerStore({ now: () => new Date('2026-09-27T12:00:00.000Z') })
    .upsertFindings(batch('req-2'), 'https://example.com')).rejects.toThrow('Clock precedes');
  expect(storage.data).toEqual(snapshot);
});

it('retention settings 7, 30, 90 and never use the inclusive latestSeen cutoff', async () => {
  for (const [policy, expected] of [[7, 0], [30, 0], [90, 1], ['never', 1]] as const) {
    const storage = fakeStorage();
    await createWorkerStore({ now: () => new Date('2026-08-30T12:00:00.000Z') })
      .upsertFindings(batch('req-old'), 'https://example.com');
    storage.data.subscriptions = [{ id: 'sub-1', merchant: 'Market', amount: '12.50', currency: 'USD',
      cadence: 'monthly', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z' }];
    const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
    await store.setRetentionPolicy(policy);
    expect(storage.data.subscriptions).toHaveLength(1);
    expect(storage.data.retentionPolicy).toBe(policy);
    expect(await store.readHistory()).toHaveLength(expected);
  }
});

it('mark reviewed persists and a later scan retains status and firstSeen', async () => {
  const storage = fakeStorage();
  const clock = vi.fn().mockReturnValueOnce(new Date('2026-09-28T12:00:00.000Z'))
    .mockReturnValueOnce(new Date('2026-09-28T12:00:00.000Z'))
    .mockReturnValueOnce(new Date('2026-09-29T12:00:00.000Z'));
  const store = createWorkerStore({ now: clock });
  const { ids } = await store.upsertFindings(batch('req-1'), 'https://example.com');
  await store.markReviewed(ids[0]);
  await store.upsertFindings(batch('req-2'), 'https://example.com');
  expect(storage.data.reviewHistory).toEqual([expect.objectContaining({
    id: ids[0], status: 'reviewed', firstSeen: '2026-09-28T12:00:00.000Z',
    latestSeen: '2026-09-29T12:00:00.000Z',
  })]);
});

it('retention on upsert expires old records atomically with new history and receipt, but receipt replay is unchanged', async () => {
  const storage = fakeStorage();
  const old = await createWorkerStore({ now: () => new Date('2026-08-30T12:00:00.000Z') })
    .upsertFindings(batch('req-old'), 'https://example.com');
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  const next = { ...batch('req-new'), findings: [evidence('req-new', 'Annual plan $10.00')] };
  const result = await store.upsertFindings(next, 'https://example.com');
  expect(storage.data.reviewHistory).toEqual([expect.objectContaining({ id: result.ids[0] })]);
  expect(result.ids[0]).not.toBe(old.ids[0]);
  expect(storage.data.receipts).toHaveLength(2);
  const snapshot = structuredClone(storage.data);
  const writes = storage.set.mock.calls.length;
  await expect(store.upsertFindings(next, 'https://example.com')).resolves.toEqual(result);
  expect(storage.data).toEqual(snapshot);
  expect(storage.set).toHaveBeenCalledTimes(writes);
});

it('retention read expires latestSeen at the inclusive 30-day UTC instant without touching subscriptions', async () => {
  const storage = fakeStorage();
  const first = await createWorkerStore({ now: () => new Date('2026-08-30T12:00:00.000Z') })
    .upsertFindings(batch('req-old'), 'https://example.com');
  storage.data.subscriptions = [{ id: 'sub-1', merchant: 'Market', amount: '12.50', currency: 'USD',
    cadence: 'monthly', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z',
    sourceFindingId: first.ids[0] }];
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  await expect(store.readHistory()).resolves.toEqual([]);
  expect(storage.data.reviewHistory).toEqual([]);
  expect(storage.data.subscriptions).toHaveLength(1);
  expect(storage.data.receipts).toHaveLength(1);
});

it('retention keeps the last millisecond before cutoff and expires exactly at cutoff', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  await createWorkerStore({ now: () => new Date('2026-08-30T12:00:00.001Z') })
    .upsertFindings(batch('req-1'), 'https://example.com');
  expect(await store.readHistory()).toHaveLength(1);
  (storage.data.reviewHistory as Array<{ latestSeen: string; firstSeen: string }>)[0].latestSeen = '2026-08-30T12:00:00.000Z';
  (storage.data.reviewHistory as Array<{ latestSeen: string; firstSeen: string }>)[0].firstSeen = '2026-08-30T12:00:00.000Z';
  expect(await store.readHistory()).toHaveLength(0);
});

it('retention rejects unsupported settings and corrupt persisted policy without writes', async () => {
  const storage = fakeStorage();
  Object.assign(storage.data, { version: 1, subscriptions: [], reviewHistory: [], receipts: [] });
  const store = createWorkerStore();
  for (const invalid of [31, -7, 0, '30', 'forever', null]) {
    await expect(store.setRetentionPolicy(invalid)).rejects.toThrow('Invalid retention');
  }
  expect(storage.set).not.toHaveBeenCalled();
  storage.data.retentionPolicy = 31;
  const snapshot = structuredClone(storage.data);
  await expect(store.readHistory()).rejects.toThrow('Corrupt local retention');
  await expect(store.setRetentionPolicy(30)).rejects.toThrow('Corrupt local retention');
  await expect(store.upsertFindings(batch('req-1'), 'https://example.com')).rejects.toThrow('Corrupt local retention');
  expect(storage.data).toEqual(snapshot);
  expect(storage.set).not.toHaveBeenCalled();
});

it('retention write failures leave settings, history, and receipts unchanged and allow retry', async () => {
  const storage = fakeStorage();
  await createWorkerStore({ now: () => new Date('2026-08-30T12:00:00.000Z') })
    .upsertFindings(batch('req-1'), 'https://example.com');
  const snapshot = structuredClone(storage.data);
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  storage.set.mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(store.setRetentionPolicy(7)).rejects.toThrow('quota exceeded');
  expect(storage.data).toEqual(snapshot);
  storage.set.mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(store.readHistory()).rejects.toThrow('quota exceeded');
  expect(storage.data).toEqual(snapshot);
  await store.setRetentionPolicy('never');
  expect(await store.readHistory()).toHaveLength(1);
});

it('never retention still refuses the 501st distinct record without evicting or recording a receipt', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  await store.setRetentionPolicy('never');
  for (let scan = 0; scan < 5; scan++) {
    const requestId = `req-${scan}`;
    await store.upsertFindings({ ...batch(requestId), findings: Array.from({ length: 100 }, (_, index) =>
      evidence(requestId, `Monthly plan $10.00 item ${scan * 100 + index}`)) }, 'https://example.com');
  }
  const snapshot = structuredClone(storage.data);
  await expect(store.upsertFindings(batch('req-overflow'), 'https://other.example'))
    .rejects.toThrow('capacity');
  expect(storage.data).toEqual(snapshot);
  expect(storage.data.reviewHistory).toHaveLength(500);
});

it('retention setting and scan serialize so a concurrent scan uses the new cutoff', async () => {
  const storage = fakeStorage();
  await createWorkerStore({ now: () => new Date('2026-09-19T12:00:00.000Z') })
    .upsertFindings(batch('req-old'), 'https://example.com');
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  const [, next] = await Promise.all([
    store.setRetentionPolicy(7),
    store.upsertFindings({ ...batch('req-new'), findings: [evidence('req-new', 'Annual plan $10.00')] }, 'https://example.com'),
  ]);
  expect(storage.data.retentionPolicy).toBe(7);
  expect(storage.data.reviewHistory).toEqual([expect.objectContaining({ id: next.ids[0] })]);
  expect(storage.data.receipts).toHaveLength(2);
});

it('retention review status failure does not mark record or mutate receipt', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore({ now: () => new Date('2026-09-29T12:00:00.000Z') });
  const { ids } = await store.upsertFindings(batch('req-1'), 'https://example.com');
  const snapshot = structuredClone(storage.data);
  storage.set.mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(store.markReviewed(ids[0])).rejects.toThrow('quota exceeded');
  expect(storage.data).toEqual(snapshot);
  await expect(store.markReviewed('bad-id')).rejects.toThrow('Finding not found');
  await store.markReviewed(ids[0]);
  expect((storage.data.reviewHistory as Array<{ status: string }>)[0].status).toBe('reviewed');
});
