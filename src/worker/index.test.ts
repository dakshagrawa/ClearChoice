import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const listeners: Array<(message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean | undefined> = [];
const state: Record<string, unknown> = {};
const sessionState: Record<string, unknown> = {};
const setAccessLevel = vi.fn().mockResolvedValue(undefined);
const sessionAccessLevel = vi.fn().mockResolvedValue(undefined);
const sessionGet = vi.fn().mockImplementation(async (key: string) => ({ [key]: sessionState[key] }));
const sessionSet = vi.fn().mockImplementation(async (value: Record<string, unknown>) => { Object.assign(sessionState, value); });
const query = vi.fn().mockResolvedValue([{ id: 42 }]);
const tabGet = vi.fn().mockResolvedValue({ id: 42, url: 'https://merchant.test/checkout' });
const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, documentId: 'doc-A', result: undefined }]);
const sendMessage = vi.fn().mockResolvedValue({ ok: true, status: 'unsupported-context', findingCount: 0 });
const get = vi.fn().mockImplementation(async () => ({ ...state }));
const set = vi.fn().mockImplementation(async (value: Record<string, unknown>) => { Object.assign(state, value); });
const popup = { id: 'extension', url: 'chrome-extension://extension/popup/index.html' } as chrome.runtime.MessageSender;
const content = { id: 'extension', tab: { id: 42 }, frameId: 0, documentId: 'doc-A', url: 'https://merchant.test/checkout' } as chrome.runtime.MessageSender;

async function boot() {
  vi.stubGlobal('chrome', { runtime: { id: 'extension', onMessage: { addListener: (fn: typeof listeners[number]) => listeners.push(fn) } }, tabs: { query, get: tabGet, sendMessage }, scripting: { executeScript }, storage: { local: { setAccessLevel, get, set }, session: { setAccessLevel: sessionAccessLevel, get: sessionGet, set: sessionSet } } });
  await import('./index');
  await vi.waitFor(() => expect(listeners).toHaveLength(1));
}
async function dispatch(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  return new Promise((resolve) => { const accepted = listeners[0](message, sender, resolve); if (!accepted) resolve(undefined); });
}
afterEach(() => { listeners.length = 0; for (const key of Object.keys(state)) delete state[key]; for (const key of Object.keys(sessionState)) delete sessionState[key]; vi.clearAllMocks(); query.mockResolvedValue([{ id: 42 }]); vi.resetModules(); vi.unstubAllGlobals(); });

it('coordinates a popup Analyze only after trusted-only storage initialization and targets the injected top document', async () => {
  await boot();
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: true, status: 'unsupported-context', findingCount: 0 });
  expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ['content.js'] });
  expect(sendMessage).toHaveBeenCalledWith(42, expect.objectContaining({ type: 'CLEARCHOICE_ANALYZE' }), { documentId: 'doc-A' });
});

it('fails closed on storage access-level rejection without injecting or writing', async () => {
  setAccessLevel.mockRejectedValueOnce(new Error('denied'));
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
  sessionAccessLevel.mockRejectedValueOnce(new Error('denied'));
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
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    query.mockResolvedValue([{ id: 7 }]);
    releaseRead({ ...state });
    expect(await submission).toEqual({ ok: false, error: 'request-failed' });
    return { ok: true, status: 'supported', findingCount: 1 };
  });
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: 'request-failed' });
  expect(set).toHaveBeenCalledTimes(writes);
  expect(state).toEqual(snapshot);
});

it.each(['Cannot access a PDF document.', 'The extensions gallery cannot be scripted.', 'script failed'])('reports restricted and generic injection failures without messaging: %s', async (reason) => {
  await boot();
  executeScript.mockRejectedValueOnce(new Error(reason));
  expect(await dispatch({ type: 'CLEARCHOICE_ANALYZE' }, popup)).toEqual({ ok: false, error: reason === 'script failed' ? 'injection-failed' : 'restricted-page' });
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
