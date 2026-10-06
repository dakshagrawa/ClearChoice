/* global document, location, chrome */
// @vitest-environment node
import { JSDOM } from 'jsdom';
import { expect, test, vi } from 'vitest';
import { installDenialReceiver, instrumentDenialPopup, denialRequestPassed, denialDetachmentCutoff } from '../scripts/human-denial-evidence.mjs';
import { runSiteCheckpoints } from '../scripts/manual-active-tab-qa.mjs';
const expected = { popupUrl: 'chrome-extension://' + 'a'.repeat(32) + '/popup/index.html', origin: 'https://checkout-b.test:123', tabId: 7, nonce: 'a'.repeat(32), timeoutMs: 300000 };
async function fixture() {
  let listener;
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const values = { storage: {}, permissions: { origins: [] }, scripts: [], tabs: [{ id: 7, url: expected.origin }] };
  const api = { runtime: { id: 'a'.repeat(32), onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: { get: async () => values.storage } }, permissions: { getAll: async () => values.permissions },
    scripting: { getRegisteredContentScripts: async () => values.scripts },
    tabs: { query: async () => values.tabs, onActivated: event(), onUpdated: event() } };
  const host = {};
  await installDenialReceiver(api, host, expected);
  host.__qaDenial.state.ready = true; // Model completed observer detach.
  host.__qaDenial.state.detachedAfter = 101;
  const sender = { id: api.runtime.id, url: expected.popupUrl };
  const message = { type: 'QA_PERMISSION_REQUEST_INVOKED', nonce: expected.nonce, origin: expected.origin, tabId: 7, trusted: true, invokedAt: 102 };
  return { host, api, values, send: (m = message, s = sender) => listener(m, s), message, sender };
}
test('synthetic receiver requires fresh exact request, trusted click, site, tab and sender', async () => {
  const good = await fixture(); good.send();
  expect(denialRequestPassed(good.host.__qaDenial.state, expected)).toBe(true);
  for (const change of [{ nonce: 'stale' }, { origin: 'https://checkout-a.test:123' }, { tabId: 8 }, { trusted: false }, { surplus: true }]) {
    const f = await fixture(); f.send({ ...f.message, ...change });
    expect(denialRequestPassed(f.host.__qaDenial.state, expected)).toBe(false);
  }
  for (const change of [{ url: expected.origin }, { id: 'b'.repeat(32) }, { tab: { id: 7 } }]) {
    const f = await fixture(); f.send(f.message, { ...f.sender, ...change });
    expect(denialRequestPassed(f.host.__qaDenial.state, expected)).toBe(false);
  }
  const absent = await fixture(); expect(denialRequestPassed(absent.host.__qaDenial.state, expected)).toBe(false);
  const early = await fixture(); early.host.__qaDenial.state.ready = false; early.send();
  expect(denialRequestPassed(early.host.__qaDenial.state, expected)).toBe(false);
  expect(denialRequestPassed(good.host.__qaDenial.state, expected, good.host.__qaDenial.state.started + 300001)).toBe(false);
  good.send(); expect(denialRequestPassed(good.host.__qaDenial.state, expected)).toBe(false);
});
test('delayed pre-detachment invocation cannot become valid when delivered after readiness', async () => {
  const f = await fixture();
  const state = f.host.__qaDenial.state;
  state.ready = false;
  // The trusted invocation occurs while CDP is attached; its message is queued.
  const queued = { ...f.message, invokedAt: 100 };
  state.detachedAfter = 101;
  state.ready = true;
  f.send(queued);
  expect(denialRequestPassed(state, expected)).toBe(false);
});
test('invocation boundary, absent calibration, stale times and backwards receiver clock fail closed', async () => {
  for (const invokedAt of [100, 101, 300102, NaN, Infinity, undefined, '102']) {
    const f = await fixture(); f.send({ ...f.message, invokedAt });
    expect(denialRequestPassed(f.host.__qaDenial.state, expected)).toBe(false);
  }
  const absent = await fixture(); absent.host.__qaDenial.state.detachedAfter = null; absent.send();
  expect(denialRequestPassed(absent.host.__qaDenial.state, expected)).toBe(false);
  const rollback = await fixture(); rollback.send();
  expect(denialRequestPassed(rollback.host.__qaDenial.state, expected, rollback.host.__qaDenial.state.started - 1)).toBe(false);
  const expired = await fixture(); expired.host.__qaDenial.state.started -= expected.timeoutMs + 1; expired.send();
  expect(denialRequestPassed(expired.host.__qaDenial.state, expected)).toBe(false);
});
test('detachment cutoff overbounds sample-to-detach without comparing wall epochs', () => {
  // Popup sample at host 105; detach completed at host 110.25: actual popup
  // detach time is 505.25, while the conservative cutoff is 512.
  expect(denialDetachmentCutoff(500, 100, 110.25)).toBe(512);
  expect(denialDetachmentCutoff(500, 100, 100)).toBe(501);
  for (const args of [[500, 110, 100], [NaN, 100, 110], [500, -1, 110]]) {
    expect(() => denialDetachmentCutoff(...args)).toThrow('calibration');
  }
});
test('approved DENIED is required after request evidence and isolation, rechecked after ack', async () => {
  const events = [];
  const evidence = { observed: async () => { events.push('request'); return true; }, passed: async () => true, close: vi.fn() };
  const options = { instruct: () => {}, acknowledge: async token => { events.push(token ?? 'DONE'); return token ?? 'DONE'; },
    navigate: async () => {}, read: async () => true, quiet: async () => true, positive: async () => true,
    denied: async () => evidence, integrity: async () => {}, mutate: async () => {}, lifecycle: async () => {} };
  await runSiteCheckpoints(options);
  expect(events.indexOf('request')).toBeLessThan(events.indexOf('DENIED'));
  expect(evidence.close).toHaveBeenCalledOnce();
  await expect(runSiteCheckpoints({ ...options, acknowledge: async () => 'DONE' })).rejects.toThrow('human DENIED');
  await expect(runSiteCheckpoints({ ...options, denied: async () => ({ ...evidence, observed: async () => false }) })).rejects.toThrow('request');
  let checks = 0;
  await expect(runSiteCheckpoints({ ...options, denied: async () => ({ ...evidence, passed: async () => ++checks === 1 }) })).rejects.toThrow('changed');
});
test('denial isolation rejects grants, scripts, records, receipts, settings and changed tabs/origins', async () => {
  for (const change of [
    { permissions: { origins: [expected.origin + '/*'] } }, { scripts: [{ id: 'unexpected' }] },
    { storage: { grantState: { sites: { [expected.origin]: { enabled: true } } } } },
    { storage: { reviewHistory: [{ id: 'unexpected' }] } }, { storage: { subscriptions: [{ id: 'unexpected' }] } },
    { storage: { receipts: [{ requestId: 'unexpected' }] } }, { storage: { dismissed: true } },
    { tabs: [{ id: 8, url: expected.origin }] }, { tabs: [{ id: 7, url: 'https://checkout-a.test:123' }] },
  ]) {
    const f = await fixture(); f.send(); expect(await f.host.__qaDenial.isolated()).toBe(true);
    Object.assign(f.values, change); expect(await f.host.__qaDenial.isolated()).toBe(false);
  }
  for (const event of ['activated', 'updated']) {
    const f = await fixture(); f.send();
    if (event === 'activated') f.host.__qaDenial.activated({ tabId: 8 });
    else f.host.__qaDenial.updated(7, { url: expected.origin + '/different' });
    expect(denialRequestPassed(f.host.__qaDenial.state, expected)).toBe(false);
  }
});
test('synthetic instrumentation forwards the actual request before witnessing; never awaits its result', async () => {
  const dom = new JSDOM('<button data-action="site-enable">Enable</button><p data-site-status>Detection off for https://checkout-b.test:123.</p>', { url: expected.popupUrl }); // Fixed synthetic markup only.
  globalThis.document = dom.window.document; globalThis.location = dom.window.location;
  const local = { ...expected, popupUrl: location.href };
  const events = [];
  const pending = new Promise(() => {});
  const original = vi.fn(() => { events.push(['real']); return pending; });
  globalThis.chrome = { tabs: { query: async () => [{ id: 7, url: expected.origin }], getCurrent: async () => undefined },
    runtime: { sendMessage: async message => events.push(['witness', message]) },
    permissions: { request: original } };
  delete globalThis.__qaDenialInstalled;
  const sample = await instrumentDenialPopup(local);
  expect(Number.isFinite(sample.sampledAt)).toBe(true);
  document.querySelector('button').click(); // Synthetic/untrusted, must not pass.
  expect(chrome.permissions.request({ origins: [expected.origin + '/*'] })).toBe(pending);
  expect(events[0]).toEqual(['real']);
  expect(events[1][1].trusted).toBe(false);
  expect(events[1][1].invokedAt).toBeGreaterThanOrEqual(sample.sampledAt);
  expect(chrome.permissions.request.mock).toBeUndefined(); // Wrapper, not a replacement mock.
  const callback = vi.fn();
  const request = { origins: [expected.origin + '/*'] };
  // Callback overload and receiver are forwarded unchanged, even though that
  // non-production overload cannot satisfy this runner's exact request witness.
  expect(chrome.permissions.request.call(chrome.permissions, request, callback)).toBe(pending);
  expect(original).toHaveBeenLastCalledWith(request, callback);
  expect(original.mock.contexts[1]).toBe(chrome.permissions);
  expect(events[3][1].origin).toBe('');
  const failure = new Error('real API failure');
  original.mockImplementationOnce(() => { throw failure; });
  expect(() => chrome.permissions.request(request)).toThrow(failure);
  expect(events).toHaveLength(4); // A thrown call produces no successful invocation witness.
  delete globalThis.chrome; delete globalThis.__qaDenialInstalled; delete globalThis.document; delete globalThis.location; dom.window.close();
});
