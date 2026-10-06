// @vitest-environment node
import { expect, test, vi } from 'vitest';
vi.mock('../scripts/passive-native-popup.mjs', async importOriginal => ({
  ...await importOriginal(), passiveNativePopup: vi.fn(),
}));
import { passiveNativePopup } from '../scripts/passive-native-popup.mjs';
import { armHumanDenial, denialRequestPassed } from '../scripts/human-denial-evidence.mjs';

async function setup(close) {
  let listener;
  const event = () => ({ addListener() {}, removeListener() {} });
  const api = {
    runtime: { id: 'a'.repeat(32), onMessage: { addListener(fn) { listener = fn; }, removeListener() {} } },
    storage: { local: { get: async () => ({}) } }, permissions: { getAll: async () => ({ origins: [] }) },
    scripting: { getRegisteredContentScripts: async () => [] },
    tabs: { query: async () => [{ id: 7 }], onActivated: event(), onUpdated: event() },
  };
  const host = { __qaTabId: 7 };
  const worker = { evaluate: async (fn, arg) => typeof fn === 'string'
    ? Function('chrome', 'globalThis', `return ${fn}`)(api, host)
    : Function('globalThis', 'chrome', 'arg', `return (${fn.toString()})(arg)`)(host, api, arg) };
  passiveNativePopup.mockResolvedValue({ evaluate: async () => ({ sampledAt: 100 }), close });
  const arm = () => armHumanDenial({ context: {}, worker,
    popupUrl: `chrome-extension://${api.runtime.id}/popup/index.html`, origin: 'https://checkout-b.test:123', instruct() {}, timeoutMs: 10000 });
  const send = invokedAt => {
    const expected = host.__qaDenial.state.expected;
    listener({ type: 'QA_PERMISSION_REQUEST_INVOKED', nonce: expected.nonce,
      origin: expected.origin, tabId: expected.tabId, trusted: true, invokedAt }, { id: api.runtime.id, url: expected.popupUrl });
  };
  return { host, arm, send };
}

test('readiness waits for successful actual detachment; queued attached invocation still fails', async () => {
  let release, closing;
  const reached = new Promise(resolve => { closing = resolve; });
  const detached = new Promise(resolve => { release = resolve; });
  const f = await setup(async () => { closing(); await detached; });
  const pending = f.arm();
  await reached;
  expect(f.host.__qaDenial.state.ready).toBe(false);
  // Sample and invocation share the popup clock; message is delayed until ready.
  const earlyInvocation = 100;
  release();
  const evidence = await pending;
  expect(f.host.__qaDenial.state.detachedAfter).toBeGreaterThan(earlyInvocation);
  f.send(earlyInvocation);
  expect(await evidence.passed()).toBe(false);
  await evidence.close();
});

test('failed detachment cannot create ready evidence', async () => {
  const f = await setup(async () => { throw new Error('detach failed'); });
  await expect(f.arm()).rejects.toThrow('detach failed');
  expect(f.host.__qaDenial).toBeUndefined();
});

test('post-cutoff invocation remains valid after successful detachment', async () => {
  const f = await setup(async () => {});
  const evidence = await f.arm();
  f.send(f.host.__qaDenial.state.detachedAfter + 1);
  expect(denialRequestPassed(f.host.__qaDenial.state, f.host.__qaDenial.state.expected)).toBe(true);
  expect(await evidence.passed()).toBe(true);
  await evidence.close();
});
