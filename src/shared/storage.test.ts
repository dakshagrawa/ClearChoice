import { beforeEach, expect, it, vi } from 'vitest';

import { getDismissed, setDismissed, loadLocalState, saveConfirmedSubscriptions, loadGrantState, saveGrantState, isGrantOrigin } from './storage';

const manual = {
  id: 'sub-1', merchant: 'Example Market', amount: '12.50', currency: 'USD', cadence: 'monthly' as const,
  createdAt: '2026-09-28T12:00:00.000Z', updatedAt: '2026-09-28T12:00:00.000Z',
};
const finding = {
  id: 'finding-1', origin: 'https://example.com', kind: 'recurring-charge', reason: 'price-cadence',
  screenedExcerpt: 'Monthly plan /checkout?token=private', opaqueFingerprint: 'a'.repeat(64), ordinal: 1,
  firstSeen: '2026-09-28T12:00:00.000Z', latestSeen: '2026-09-28T12:01:00.000Z', status: 'needs-review',
};

const get = vi.fn();
const set = vi.fn();

beforeEach(() => {
  get.mockReset();
  set.mockReset();
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { storage: { local: { get, set } } },
  });
});

it('rejects corrupt versioned grant records without rewriting them', async () => {
  for (const grantState of [
    { version: 2, sites: {} }, { version: 1, sites: { 'https://a.test': { enabled: true, generation: 0 } } },
    { version: 1, sites: { 'https://a.test/path': { enabled: true, generation: 1 } } },
    { version: 1, sites: { 'https://a.test': { enabled: true, generation: 1, extra: 'x' } } },
  ]) {
    get.mockResolvedValue({ grantState });
    await expect(loadGrantState()).rejects.toThrow('Corrupt grant state');
  }
  expect(set).not.toHaveBeenCalled();
});

it('isolates grant state from review storage and rejects unsafe origins', async () => {
  const data: Record<string, unknown> = {};
  get.mockImplementation(async () => ({ ...data }));
  set.mockImplementation(async (value) => { Object.assign(data, value); });
  expect(await loadGrantState()).toEqual({ version: 1, sites: {} });
  await saveGrantState({ version: 1, sites: { 'https://a.test': { enabled: false, generation: 2 } } });
  expect(data).toEqual({ grantState: { version: 1, sites: { 'https://a.test': { enabled: false, generation: 2 } } } });
  for (const unsafe of ['http://a.test', 'https://a.test/', 'https://a.test/checkout', 'https://a.test?q=x', 'https://a.test#x', 'https://*.test', 'https://127.0.0.1']) {
    expect(isGrantOrigin(unsafe)).toBe(false);
  }
});

it('reads only the local dismissed flag', async () => {
  get.mockResolvedValue({ dismissed: true, unrelated: 'not read' });

  await expect(getDismissed()).resolves.toBe(true);
  expect(get).toHaveBeenCalledWith('dismissed');
});

it('persists only the dismissed boolean locally', async () => {
  set.mockResolvedValue(undefined);

  await setDismissed(true);

  expect(set).toHaveBeenCalledWith({ dismissed: true });
  expect(set).toHaveBeenCalledTimes(1);
});

it('round-trips an explicitly saved manual subscription without inventing sourceFindingId', async () => {
  const data: Record<string, unknown> = {};
  get.mockImplementation(async () => ({ ...data }));
  set.mockImplementation(async (items) => { Object.assign(data, items); });

  await saveConfirmedSubscriptions([manual]);
  expect(await loadLocalState()).toEqual({
    version: 1, dismissed: false, subscriptions: [manual], reviewHistory: [], retentionPolicy: 30,
  });
  expect(data.subscriptions).toEqual([manual]);
  expect(data.reviewHistory).toEqual([]);
  expect(Object.hasOwn((data.subscriptions as Array<Record<string, unknown>>)[0], 'sourceFindingId')).toBe(false);
});

it('migrates the legacy dismissed flag without creating a subscription or finding', async () => {
  const data: Record<string, unknown> = { dismissed: true };
  get.mockImplementation(async () => ({ ...data }));
  set.mockImplementation(async (items) => { Object.assign(data, items); });
  expect(await loadLocalState()).toEqual({ version: 1, dismissed: true, subscriptions: [], reviewHistory: [], retentionPolicy: 30 });
  expect(data).toEqual({ dismissed: true, version: 1, subscriptions: [], reviewHistory: [], retentionPolicy: 30 });
  expect(set).toHaveBeenCalledTimes(1);
  await loadLocalState();
  expect(set).toHaveBeenCalledTimes(1);
});

it('does not silently overwrite corrupt existing subscription state', async () => {
  const data = { version: 1, dismissed: true, subscriptions: [{ ...manual, selector: '#card' }], reviewHistory: [] };
  get.mockResolvedValue(data);
  await expect(loadLocalState()).rejects.toThrow('Corrupt local subscriptions');
  await expect(saveConfirmedSubscriptions([manual])).rejects.toThrow('Corrupt local subscriptions');
  expect(set).not.toHaveBeenCalled();
});

it('does not overwrite corrupt review history or unsupported versions', async () => {
  for (const data of [
    { version: 1, subscriptions: [], reviewHistory: [{ evidence: 'private data' }] },
    { version: 2, subscriptions: [], reviewHistory: [] },
    { subscriptions: [manual] },
  ]) {
    get.mockResolvedValue(data);
    await expect(loadLocalState()).rejects.toThrow();
  }
  expect(set).not.toHaveBeenCalled();
});

it('rejects a corrupt path-bearing review history without rewriting local state', async () => {
  get.mockResolvedValue({ version: 1, dismissed: false, subscriptions: [], reviewHistory: [finding] });
  await expect(loadLocalState()).rejects.toThrow('Corrupt local review history');
  expect(set).not.toHaveBeenCalled();
});

it('rejects unsafe save payload before touching storage', async () => {
  await expect(saveConfirmedSubscriptions([{ ...manual, amount: '12.345' }])).rejects.toThrow('Invalid');
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});

it('surfaces local storage errors', async () => {
  const error = new Error('storage unavailable');
  get.mockRejectedValue(error);

  await expect(getDismissed()).rejects.toThrow('storage unavailable');
});

it('reads legacy completed and exact provisional grant records without migration writes', async () => {
  for (const grant of [{ enabled: true, generation: 1 }, { enabled: false, generation: 2 }, { enabled: true, generation: 3, provisional: true }]) {
    const grantState = { version: 1, sites: { 'https://a.test': grant } };
    get.mockResolvedValue({ grantState });
    expect(await loadGrantState()).toEqual(grantState);
    await saveGrantState(await loadGrantState());
    expect(set).toHaveBeenLastCalledWith({ grantState });
  }
});

it('rejects malformed provisional markers on read and write', async () => {
  for (const grant of [
    { enabled: true, generation: 1, provisional: false },
    { enabled: true, generation: 1, provisional: undefined },
    { enabled: true, generation: 1, provisional: 1 },
    { enabled: true, generation: 1, provisional: { generation: 1 } },
    { enabled: false, generation: 1, provisional: true },
    { enabled: true, generation: 1, provisional: true, extra: true },
    { enabled: true, provisional: true },
  ]) {
    const grantState = { version: 1, sites: { 'https://a.test': grant } };
    get.mockResolvedValue({ grantState });
    await expect(loadGrantState()).rejects.toThrow('Corrupt grant state');
    await expect(saveGrantState(grantState as Parameters<typeof saveGrantState>[0])).rejects.toThrow('Invalid grant state');
  }
  expect(set).not.toHaveBeenCalled();
});
