import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
import { createWorkerStore } from './store';
import { createGrantManager } from './grants';

function fixture() {
  const data: Record<string, unknown> = { version: 1, subscriptions: [], reviewHistory: [] };
  const scripts: chrome.scripting.RegisteredContentScript[] = [];
  const allowed = new Set<string>();
  const session: Record<string, unknown> = {};
  const tabs = [{ id: 12, url: 'https://a.test/checkout' }, { id: 13, url: 'https://b.test/checkout' }];
  const sendMessage = vi.fn(async () => undefined);
  const setBadgeText = vi.fn(async () => undefined);
  const get = vi.fn(async () => structuredClone(data));
  const set = vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); });
  const registerContentScripts = vi.fn(async (items: chrome.scripting.RegisteredContentScript[]) => { scripts.push(...items); });
  const unregisterContentScripts = vi.fn(async ({ ids }: { ids: string[] }) => { for (const id of ids) { const index = scripts.findIndex((script) => script.id === id); if (index >= 0) scripts.splice(index, 1); } });
  const getRegisteredContentScripts = vi.fn(async (filter?: { ids?: string[] }) => structuredClone(filter?.ids ? scripts.filter((script) => filter.ids!.includes(script.id)) : scripts));
  const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins.every((origin) => allowed.has(origin)));
  vi.stubGlobal('chrome', { storage: { local: { get, set }, session: { get: vi.fn(async (key: string) => ({ [key]: session[key] })), remove: vi.fn(async (key: string) => { delete session[key]; }) } }, scripting: { registerContentScripts, unregisterContentScripts, getRegisteredContentScripts }, permissions: { contains }, tabs: { query: vi.fn(async () => tabs), sendMessage }, action: { setBadgeText } });
  return { data, scripts, allowed, session, tabs, sendMessage, setBadgeText, get, set, registerContentScripts, unregisterContentScripts, getRegisteredContentScripts, contains };
}

async function completedEnable(grants: ReturnType<typeof createGrantManager>, origin: string) {
  const result = await grants.enable(origin);
  if (result.newlyEnabled) await grants.completeEnable(origin, result.generation);
  return result;
}

it('enables exactly a previously granted HTTPS site, never a second site', async () => {
  const f = fixture();
  const grants = createGrantManager(createWorkerStore());
  f.allowed.add('https://a.test/*');
  await completedEnable(grants, 'https://a.test');
  expect(await grants.isEnabled('https://a.test', 1)).toBe(true);
  expect(await grants.isEnabled('https://b.test', 1)).toBe(false);
  expect(f.scripts).toEqual([{ id: expect.stringMatching(/^clearchoice-site-/), matches: ['https://a.test/*'], js: ['content.js'], allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' }]);
  expect(f.data.grantState).toEqual({ version: 1, sites: { 'https://a.test': { enabled: true, generation: 1 } } });
  expect(f.registerContentScripts).toHaveBeenCalledTimes(1);
  expect((chrome.permissions as unknown as { request?: unknown }).request).toBeUndefined();
});

it('rejects denied, malformed and non-HTTPS origins without enabling or registering', async () => {
  const f = fixture(); const grants = createGrantManager(createWorkerStore());
  for (const origin of ['https://a.test', 'https://a.test/', 'https://a.test/path', 'https://a.test?x=1', 'https://a.test#x', 'https://*.test', 'https://127.0.0.1', 'http://a.test']) {
    await expect(grants.enable(origin)).rejects.toThrow();
  }
  expect(f.scripts).toEqual([]); expect(f.data.grantState).toBeUndefined();
  expect(f.registerContentScripts).not.toHaveBeenCalled();
});

it('registration failure and storage failure leave no enabled script or grant', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const grants = createGrantManager(createWorkerStore());
  f.registerContentScripts.mockRejectedValueOnce(new Error('registration failed'));
  await expect(grants.enable('https://a.test')).rejects.toThrow('registration failed');
  expect(f.scripts).toHaveLength(0);
  f.set.mockRejectedValueOnce(new Error('quota exceeded'));
  await expect(grants.enable('https://a.test')).rejects.toThrow('quota exceeded');
  expect(f.scripts).toHaveLength(0); expect(f.data.grantState).toBeUndefined();
  expect(await grants.isEnabled('https://a.test', 1)).toBe(false);
});

it('revocation advances generation and only unregisters the specified site', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*'); f.allowed.add('https://b.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test'); await completedEnable(grants, 'https://b.test');
  await grants.revoke('https://a.test');
  expect(f.data.grantState).toEqual({ version: 1, sites: {
    'https://a.test': { enabled: false, generation: 2 }, 'https://b.test': { enabled: true, generation: 1 },
  } });
  expect(await grants.isEnabled('https://a.test', 1)).toBe(false);
  expect(await grants.isEnabled('https://b.test', 1)).toBe(true);
  expect(f.scripts.map((script) => script.matches)).toEqual([['https://b.test/*']]);
  expect(f.allowed.has('https://a.test/*')).toBe(true);
  await completedEnable(grants, 'https://a.test');
  expect(await grants.isEnabled('https://a.test', 1)).toBe(false);
  expect(await grants.isEnabled('https://a.test', 3)).toBe(true);
});

it('permission removal cleans an automatic document with hidden tab URL and leaves B untouched', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*'); f.allowed.add('https://b.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test'); await completedEnable(grants, 'https://b.test');
  f.tabs[0].url = undefined as unknown as string;
  f.session['clearchoice.automatic.12'] = { tabId: 12, documentId: 'doc-A', origin: 'https://a.test' };
  f.session['clearchoice.automatic.13'] = { tabId: 13, documentId: 'doc-B', origin: 'https://b.test' };
  f.allowed.delete('https://a.test/*');
  await grants.onRemoved(['https://*/*']);
  expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(12, { type: 'CLEARCHOICE_DISABLE' }, { documentId: 'doc-A' });
  expect(f.setBadgeText).toHaveBeenCalledExactlyOnceWith({ tabId: 12, text: '' });
  expect(f.session['clearchoice.automatic.12']).toBeUndefined();
  expect(f.session['clearchoice.automatic.13']).toEqual({ tabId: 13, documentId: 'doc-B', origin: 'https://b.test' });
});

it('external permission removal disables A while B remains active', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*'); f.allowed.add('https://b.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test'); await completedEnable(grants, 'https://b.test');
  f.allowed.delete('https://a.test/*'); await grants.onRemoved(['https://a.test/*']);
  expect(await grants.isEnabled('https://a.test', 1)).toBe(false);
  expect(await grants.isEnabled('https://b.test', 1)).toBe(true);
  expect((f.data.grantState as { sites: Record<string, { generation: number }> }).sites['https://a.test'].generation).toBe(2);
  expect(f.scripts.map((script) => script.matches)).toEqual([['https://b.test/*']]);
});

it('external broad-pattern permission removal checks each site rather than comparing event text', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*'); f.allowed.add('https://b.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test'); await completedEnable(grants, 'https://b.test');
  f.allowed.delete('https://a.test/*');
  await grants.onRemoved(['https://*/*']);
  expect((f.data.grantState as { sites: Record<string, { enabled: boolean; generation: number }> }).sites).toEqual({
    'https://a.test': { enabled: false, generation: 2 }, 'https://b.test': { enabled: true, generation: 1 },
  });
  expect(f.scripts.map((script) => script.matches)).toEqual([['https://b.test/*']]);
});

it('startup reconciliation disables stale grants and removes owned orphans', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*'); f.allowed.add('https://b.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test'); await completedEnable(grants, 'https://b.test');
  f.allowed.delete('https://a.test/*');
  f.scripts.splice(f.scripts.findIndex((script) => script.matches?.[0] === 'https://b.test/*'), 1);
  f.scripts.push({ id: 'clearchoice-site-orphan', matches: ['https://orphan.test/*'], js: ['content.js'] });
  await grants.reconcile();
  expect(f.scripts).toHaveLength(0);
  expect((f.data.grantState as { sites: Record<string, { enabled: boolean; generation: number }> }).sites).toEqual({
    'https://a.test': { enabled: false, generation: 2 }, 'https://b.test': { enabled: false, generation: 2 },
  });
});

it('a failed revoke write still unregisters the script and rejects the old generation', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test');
  f.set.mockRejectedValueOnce(new Error('disk failure'));
  await expect(grants.revoke('https://a.test')).rejects.toThrow('disk failure');
  expect(f.scripts).toHaveLength(0);
  expect(await grants.isEnabled('https://a.test', 1)).toBe(false);
  expect(f.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: '' });
});

it('a failed unregister still attempts badge and document cleanup after disabling the grant', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  f.session['clearchoice.document.12'] = { tabId: 12, documentId: 'doc-A', origin: 'https://a.test' };
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test');
  f.unregisterContentScripts.mockRejectedValueOnce(new Error('unregister failed'));
  await expect(grants.revoke('https://a.test')).rejects.toThrow('unregister failed');
  expect(f.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: '' });
  expect(f.sendMessage).toHaveBeenCalledWith(12, { type: 'CLEARCHOICE_DISABLE' }, { documentId: 'doc-A' });
  expect((f.data.grantState as { sites: Record<string, { enabled: boolean; generation: number }> }).sites['https://a.test']).toEqual({ enabled: false, generation: 2 });
});

it('failed persistence and unregister still vetoes authorization in this worker', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test');
  f.set.mockRejectedValueOnce(new Error('disk failure'));
  f.unregisterContentScripts.mockRejectedValueOnce(new Error('unregister failed'));
  await expect(grants.revoke('https://a.test')).rejects.toThrow(/Chrome settings.*site access.*https:\/\/a\.test/i);
  expect(await grants.isEnabled('https://a.test', 1)).toBe(false);
  expect(f.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: '' });
});

it('dual revoke failure reports irrecoverable site access and honestly exposes restart limitation', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*'); f.allowed.add('https://b.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test'); await completedEnable(grants, 'https://b.test');
  f.set.mockRejectedValueOnce(new Error('disk failure'));
  f.unregisterContentScripts.mockRejectedValueOnce(new Error('unregister failed'));
  await expect(grants.revoke('https://a.test')).rejects.toThrow(/Chrome settings.*site access.*https:\/\/a\.test/i);
  expect(await grants.isEnabled('https://a.test', 1)).toBe(false);
  expect(await grants.isEnabled('https://b.test', 1)).toBe(true);
  // A fresh MV3 worker loses its in-memory veto. No successful Chrome API write can prove revocation.
  const restarted = createGrantManager(createWorkerStore());
  expect(await restarted.isEnabled('https://a.test', 1)).toBe(true);
  expect(await restarted.isEnabled('https://b.test', 1)).toBe(true);
  expect(f.allowed.has('https://b.test/*')).toBe(true);
});

it('startup with corrupt grant state unregisters every owned script but leaves foreign scripts untouched', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*'); f.allowed.add('https://b.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test'); await completedEnable(grants, 'https://b.test');
  f.scripts.push({ id: 'foreign-script', matches: ['https://other.test/*'], js: ['foreign.js'] });
  f.data.grantState = { version: 1, sites: { 'https://a.test/path': { enabled: true, generation: 1 } } };
  await expect(createGrantManager(createWorkerStore()).reconcile()).rejects.toThrow('Corrupt grant state');
  expect(f.scripts.map((script) => script.id)).toEqual(['foreign-script']);
  expect(f.allowed.has('https://a.test/*')).toBe(true);
  expect(f.data.grantState).toEqual({ version: 1, sites: { 'https://a.test/path': { enabled: true, generation: 1 } } });
});

it('rejects malformed persisted grants rather than enabling any site', async () => {
  const f = fixture();
  f.data.grantState = { version: 1, sites: { 'https://a.test/path': { enabled: true, generation: 1 } } };
  const grants = createGrantManager(createWorkerStore());
  await expect(grants.isEnabled('https://a.test', 1)).rejects.toThrow('Corrupt grant state');
  await expect(grants.reconcile()).rejects.toThrow('Corrupt grant state');
  expect(f.registerContentScripts).not.toHaveBeenCalled();
});

it('revoke clears only the site badge and targets a known document for best-effort disable', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  f.session['clearchoice.document.12'] = { tabId: 12, documentId: 'doc-A', origin: 'https://a.test' };
  f.session['clearchoice.document.13'] = { tabId: 13, documentId: 'doc-B', origin: 'https://b.test' };
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test'); await grants.revoke('https://a.test');
  expect(f.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: '' });
  expect(f.setBadgeText).not.toHaveBeenCalledWith({ tabId: 13, text: '' });
  expect(f.sendMessage).toHaveBeenCalledWith(12, { type: 'CLEARCHOICE_DISABLE' }, { documentId: 'doc-A' });
  expect(f.sendMessage).not.toHaveBeenCalledWith(13, expect.anything(), expect.anything());
});

it('a generation check inside the queued history commit does not deadlock', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const store = createWorkerStore(); const grants = createGrantManager(store);
  await completedEnable(grants, 'https://a.test');
  // The worker's Task 9 beforeCommit callback runs inside this same queue.
  const checked = store.enqueue(() => grants.isEnabled('https://a.test', 1));
  await expect(Promise.race([checked, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))])).resolves.toBe(true);
});

it('checks the active site inside the shared queue before registering', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const store = createWorkerStore(); const grants = createGrantManager(store);
  let release!: () => void;
  const first = store.enqueue(() => new Promise<void>((resolve) => { release = resolve; }));
  let active = true;
  const pending = grants.enable('https://a.test', async () => active);
  await vi.waitFor(() => expect(release).toBeDefined());
  active = false;
  release(); await first;
  await expect(pending).rejects.toThrow('Active site changed');
  expect(f.registerContentScripts).not.toHaveBeenCalled();
  expect(f.scripts).toHaveLength(0);
  expect(f.data.grantState).toBeUndefined();
});

it('grant work shares the serialized finding mutation queue', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const store = createWorkerStore(); const grants = createGrantManager(store);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const first = store.enqueue(async () => { await barrier; });
  const pending = grants.enable('https://a.test');
  await Promise.resolve(); expect(f.registerContentScripts).not.toHaveBeenCalled();
  release(); await first; await pending;
  expect(f.registerContentScripts).toHaveBeenCalledTimes(1);
});

it('checks cancellation inside the queue before touching registration or storage', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const store = createWorkerStore(); const grants = createGrantManager(store);
  let release!: () => void;
  const blocked = store.enqueue(() => new Promise<void>((resolve) => { release = resolve; }));
  await vi.waitFor(() => expect(release).toBeDefined());
  let active = true;
  const enable = grants.enable('https://a.test', async () => active);
  active = false; release(); await blocked;
  await expect(enable).rejects.toThrow('Active site changed');
  expect(f.registerContentScripts).not.toHaveBeenCalled();
  expect(f.set).not.toHaveBeenCalled();
});

it('does not bypass cancellation through the already-enabled early return', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://a.test');
  const before = structuredClone(f.data);
  let active = true;
  f.getRegisteredContentScripts.mockImplementationOnce(async () => { active = false; return structuredClone(f.scripts); });
  await expect(grants.enable('https://a.test', async () => active)).rejects.toThrow('Active site changed');
  expect(f.data).toEqual(before);
  expect(await grants.isEnabled('https://a.test', 1)).toBe(true);
});

it('provisional authorization needs a live worker owner and stops before queued rollback', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const store = createWorkerStore(); const grants = createGrantManager(store);
  let active = true;
  const { generation } = await grants.enable('https://a.test', async () => active);
  expect(f.data.grantState).toEqual({ version: 1, sites: { 'https://a.test': { enabled: true, generation, provisional: true } } });
  expect(await grants.isEnabled('https://a.test', generation)).toBe(true);
  const restarted = createGrantManager(createWorkerStore());
  expect(await restarted.isEnabled('https://a.test', generation)).toBe(false);
  active = false;
  expect(await grants.isEnabled('https://a.test', generation)).toBe(false);
  let release!: () => void;
  const blocked = store.enqueue(() => new Promise<void>((resolve) => { release = resolve; }));
  await vi.waitFor(() => expect(release).toBeDefined());
  const rollback = grants.rollbackEnable('https://a.test', generation);
  active = true;
  expect(await grants.isEnabled('https://a.test', generation)).toBe(false);
  release(); await blocked; await rollback;
});

it('stale completion and rollback cannot change a newer generation', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const grants = createGrantManager(createWorkerStore());
  const old = await grants.enable('https://a.test');
  await grants.rollbackEnable('https://a.test', old.generation);
  const next = await grants.enable('https://a.test');
  const before = structuredClone(f.data.grantState);
  await expect(grants.completeEnable('https://a.test', old.generation)).rejects.toThrow();
  await grants.rollbackEnable('https://a.test', old.generation);
  expect(f.data.grantState).toEqual(before);
  expect(await grants.isEnabled('https://a.test', next.generation)).toBe(true);
  await grants.completeEnable('https://a.test', next.generation);
  await createGrantManager(createWorkerStore()).reconcile();
  expect(await createGrantManager(createWorkerStore()).isEnabled('https://a.test', next.generation)).toBe(true);
});

it('completion storage failure retains unfinished state and rollback remains fail closed', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const grants = createGrantManager(createWorkerStore());
  const { generation } = await grants.enable('https://a.test');
  f.set.mockRejectedValueOnce(new Error('disk failure'));
  await expect(grants.completeEnable('https://a.test', generation)).rejects.toThrow('disk failure');
  f.set.mockRejectedValueOnce(new Error('disk failure'));
  f.unregisterContentScripts.mockRejectedValueOnce(new Error('unregister failure'));
  await expect(grants.rollbackEnable('https://a.test', generation)).rejects.toThrow('Revocation could not be confirmed');
  expect(await grants.isEnabled('https://a.test', generation)).toBe(false);
  const restarted = createGrantManager(createWorkerStore());
  expect(await restarted.isEnabled('https://a.test', generation)).toBe(false);
  await restarted.reconcile();
  expect(f.scripts).toHaveLength(0);
});

it.each(['none', 'storage', 'both'])('cleans cancelled completion inside its queue with %s cleanup failure', async (failure) => {
  const f = fixture(); f.allowed.add('https://a.test/*'); f.allowed.add('https://b.test/*');
  const grants = createGrantManager(createWorkerStore());
  await completedEnable(grants, 'https://b.test');
  let active = true;
  const { generation } = await grants.enable('https://a.test', async () => active);
  let release!: () => void;
  f.set.mockImplementationOnce(async (value) => {
    await new Promise<void>((resolve) => { release = resolve; });
    Object.assign(f.data, structuredClone(value));
  });
  const result = grants.completeEnable('https://a.test', generation);
  const rejected = expect(result).rejects.toThrow(failure === 'both' ? 'Revocation could not be confirmed'
    : failure === 'storage' ? 'cleanup write failed' : 'Enable no longer authorized');
  await vi.waitFor(() => expect(release).toBeDefined());
  active = false;
  if (failure !== 'none') f.set.mockRejectedValueOnce(new Error('cleanup write failed'));
  if (failure === 'both') f.unregisterContentScripts.mockRejectedValueOnce(new Error('cleanup unregister failed'));
  release(); await rejected;
  expect(await grants.isEnabled('https://a.test', generation)).toBe(false);
  expect(await grants.isEnabled('https://b.test', 1)).toBe(true);
  expect(f.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: '' });
  const restarted = createGrantManager(createWorkerStore());
  // Dual API failure cannot guarantee revocation survives a fresh worker.
  expect(await restarted.isEnabled('https://a.test', generation)).toBe(failure === 'both');
  if (failure === 'none') expect(f.data.grantState).toMatchObject({ sites: { 'https://a.test': { enabled: false, generation: generation + 1 } } });
});

it('retains the owner veto after the completion write while its final predicate is pending', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const grants = createGrantManager(createWorkerStore());
  let completing = false;
  let release!: (active: boolean) => void;
  const { generation } = await grants.enable('https://a.test', async () => {
    if (!completing) return true;
    return new Promise<boolean>((resolve) => { release = resolve; });
  });
  f.set.mockImplementationOnce(async (value) => { Object.assign(f.data, structuredClone(value)); completing = true; });
  const result = grants.completeEnable('https://a.test', generation);
  const rejected = expect(result).rejects.toThrow('Enable no longer authorized');
  await vi.waitFor(() => expect(release).toBeDefined());
  const rollback = grants.rollbackEnable('https://a.test', generation);
  expect(await grants.isEnabled('https://a.test', generation)).toBe(false);
  release(true); await rejected; await rollback;
  expect(await createGrantManager(createWorkerStore()).isEnabled('https://a.test', generation)).toBe(false);
});

it('does not revoke a newer persisted generation when cancelled completion resumes', async () => {
  const f = fixture(); f.allowed.add('https://a.test/*');
  const grants = createGrantManager(createWorkerStore());
  let active = true;
  const { generation } = await grants.enable('https://a.test', async () => active);
  f.set.mockImplementationOnce(async (value) => {
    Object.assign(f.data, structuredClone(value));
    // Model a newer durable owner becoming visible before this callback resumes.
    f.data.grantState = { version: 1, sites: { 'https://a.test': { enabled: true, generation: generation + 1 } } };
    active = false;
  });
  await expect(grants.completeEnable('https://a.test', generation)).rejects.toThrow('Enable no longer authorized');
  await grants.rollbackEnable('https://a.test', generation);
  expect(f.data.grantState).toEqual({ version: 1, sites: { 'https://a.test': { enabled: true, generation: generation + 1 } } });
  expect(f.unregisterContentScripts).not.toHaveBeenCalled();
  expect(await createGrantManager(createWorkerStore()).isEnabled('https://a.test', generation + 1)).toBe(true);
});
