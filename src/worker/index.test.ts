import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const listeners: Array<(message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean | undefined> = [];
const permissionRemoved: Array<(permissions: chrome.permissions.Permissions) => void> = [];
const registeredScripts: chrome.scripting.RegisteredContentScript[] = [];
const grantedOrigins = new Set<string>();
const getRegisteredContentScripts = vi.fn(async (filter?: { ids?: string[] }) => registeredScripts.filter((script) => !filter?.ids || filter.ids.includes(script.id)));
const registerContentScripts = vi.fn(async (scripts: chrome.scripting.RegisteredContentScript[]) => { registeredScripts.push(...scripts); });
const unregisterContentScripts = vi.fn(async ({ ids }: { ids: string[] }) => { for (const id of ids) { const index = registeredScripts.findIndex((script) => script.id === id); if (index >= 0) registeredScripts.splice(index, 1); } });
const contains = vi.fn(async ({ origins }: { origins: string[] }) => origins.every((origin) => grantedOrigins.has(origin)));
const state: Record<string, unknown> = {};
const sessionState: Record<string, unknown> = {};
const setAccessLevel = vi.fn().mockResolvedValue(undefined);
const sessionAccessLevel = vi.fn().mockResolvedValue(undefined);
const sessionGet = vi.fn().mockImplementation(async (key: string | null) => key === null ? { ...sessionState } : ({ [key]: sessionState[key] }));
const sessionSet = vi.fn().mockImplementation(async (value: Record<string, unknown>) => { Object.assign(sessionState, value); });
const sessionRemove = vi.fn().mockImplementation(async (key: string) => { delete sessionState[key]; });
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
  vi.stubGlobal('chrome', { runtime: { id: 'extension', onMessage: { addListener: (fn: typeof listeners[number]) => listeners.push(fn) } }, tabs: { query, get: tabGet, sendMessage }, action: { setBadgeText: vi.fn(async () => undefined) }, permissions: { contains, onRemoved: { addListener: (fn: typeof permissionRemoved[number]) => permissionRemoved.push(fn) } }, scripting: { executeScript, getRegisteredContentScripts, registerContentScripts, unregisterContentScripts }, storage: { local: { setAccessLevel, get, set }, session: { setAccessLevel: sessionAccessLevel, get: sessionGet, set: sessionSet, remove: sessionRemove } } });
  await import('./index');
  await vi.waitFor(() => expect(listeners).toHaveLength(1));
  await new Promise<void>((resolve) => { listeners[0]({ type: 'INVALID' }, popup, () => resolve()); });
}
async function dispatch(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return new Promise((resolve) => { const accepted = listeners[0](message, sender, resolve); if (!accepted) resolve(undefined); });
}
afterEach(() => { listeners.length = 0; permissionRemoved.length = 0; registeredScripts.length = 0; grantedOrigins.clear(); for (const key of Object.keys(state)) delete state[key]; for (const key of Object.keys(sessionState)) delete sessionState[key]; vi.clearAllMocks(); get.mockReset().mockImplementation(async () => ({ ...state })); sendMessage.mockReset().mockImplementation(async (_tab: number, message: { type: string }) => message.type === 'CLEARCHOICE_AUTO_START' ? { ok: true } : { ok: true, status: 'unsupported-context', findingCount: 0 }); query.mockReset().mockResolvedValue([{ id: 42 }]); tabGet.mockReset().mockResolvedValue({ id: 42, url: 'https://merchant.test/checkout' }); vi.resetModules(); vi.unstubAllGlobals(); });

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
