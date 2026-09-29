import { expect, it, vi } from 'vitest';
import { CLEARCHOICE_FINDINGS_BATCH } from '../shared/messages';
import { createWorkerStore } from './store';

const fingerprint = 'a'.repeat(64);
const finding = (requestId: string) => ({
  version: 1 as const, requestId, kind: 'recurring-charge' as const,
  reason: 'price-cadence' as const, screenedExcerpt: 'Monthly plan $10.00',
  opaqueFingerprint: fingerprint, ordinal: 1,
});
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
  await expect(store.upsertFindings(changed, 'https://example.com')).rejects.toThrow('collision');
  await expect(store.upsertFindings(batch('req-1'), 'https://other.example')).rejects.toThrow('collision');
  expect(storage.data).toEqual(snapshot);
  expect(storage.set).toHaveBeenCalledTimes(writes);
});

it('reports quota rejection and retries without phantom in-memory success', async () => {
  const storage = fakeStorage();
  const store = createWorkerStore();
  storage.set.mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(store.upsertFindings(batch('req-1'), 'https://example.com')).rejects.toThrow('quota exceeded');
  expect(storage.data).toEqual({});
  const outcome = await store.upsertFindings(batch('req-1'), 'https://example.com');
  expect(outcome.ids).toHaveLength(1);
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
  duplicate.findings.push({ ...finding('req-1'), screenedExcerpt: 'Annual plan' });
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
  const findings = Array.from({ length: 100 }, (_, index) => ({
    ...finding('req-1'), opaqueFingerprint: index.toString(16).padStart(64, '0'),
  }));
  for (let scan = 0; scan < 5; scan++) {
    await store.upsertFindings({ ...batch(`req-${scan}`), findings: findings.map((entry) => ({
      ...entry, requestId: `req-${scan}`, opaqueFingerprint: (scan * 100 + Number.parseInt(entry.opaqueFingerprint, 16)).toString(16).padStart(64, '0'),
    })) }, 'https://example.com');
  }
  const snapshot = structuredClone(storage.data);
  const writes = storage.set.mock.calls.length;
  await expect(store.upsertFindings({ ...batch('overflow'), findings: [{ ...finding('overflow'), opaqueFingerprint: 'f'.repeat(64) }] }, 'https://example.com'))
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
