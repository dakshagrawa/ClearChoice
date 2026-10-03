// @vitest-environment node
/* global queueMicrotask */
import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { passiveNativePopup, readNativePopup, waitForNativePopup } from '../scripts/passive-native-popup.mjs';

const url = `chrome-extension://${'a'.repeat(32)}/popup/index.html`;
function fixture({ targets, native = true, stall = false } = {}) {
  const target = { targetId: 'native', type: 'page', browserContextId: 'owned', url };
  const cdp = new EventEmitter();
  cdp.detach = vi.fn(async () => {});
  let live = true;
  const commands = [];
  cdp.send = vi.fn(async (method, params) => {
    commands.push([method, params]);
    if (method === 'Target.getTargets') return { targetInfos: targets ?? [target] };
    if (method === 'Target.getTargetInfo') { if (!live) throw Error('closed'); return { targetInfo: target }; }
    if (method === 'Target.attachToTarget') return { sessionId: 'exact' };
    if (method === 'Target.sendMessageToTarget') {
      const message = JSON.parse(params.message);
      if (!stall) queueMicrotask(() => cdp.emit('Target.receivedMessageFromTarget', { sessionId: params.sessionId, message: JSON.stringify({ id: message.id, result: { result: { value: message.params.expression.includes('chrome.tabs.getCurrent') ? native : true } } }) }));
    }
  });
  const context = { pages: () => [{ isClosed: () => false }], newCDPSession: async () => ({ send: async () => ({ targetInfo: { browserContextId: 'owned' } }), detach: async () => {} }), browser: () => ({ newBrowserCDPSession: async () => cdp }) };
  return { context, cdp, commands, target, destroy: () => { live = false; cdp.emit('Target.detachedFromTarget', { sessionId: 'exact' }); } };
}

test('passive discovery observes a target absent from Playwright Pages; only exact session events propagate', async () => {
  const f = fixture();
  const popup = await passiveNativePopup(f.context, url);
  expect(await popup.evaluate('true')).toBe(true);
  const listener = vi.fn(); popup.session.on('Page.javascriptDialogOpening', listener);
  f.cdp.emit('Target.receivedMessageFromTarget', { sessionId: 'other', message: JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { type: 'confirm' } }) });
  expect(listener).not.toHaveBeenCalled();
  f.cdp.emit('Target.receivedMessageFromTarget', { sessionId: 'exact', message: JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { type: 'confirm' } }) });
  expect(listener).toHaveBeenCalledOnce();
  await expect(popup.session.send('Page.handleJavaScriptDialog', { accept: true })).rejects.toThrow('non-observation');
  await expect(popup.session.send('Input.dispatchKeyEvent', { key: 'Enter' })).rejects.toThrow('non-observation');
  f.destroy();
  expect(popup.isClosed()).toBe(true);
  await expect(popup.evaluate('true')).rejects.toThrow('closed');
  await popup.close();
  expect(f.commands.map(([method]) => method).every(method => ['Target.getTargets', 'Target.getTargetInfo', 'Target.attachToTarget', 'Target.sendMessageToTarget'].includes(method))).toBe(true);
  expect(f.cdp.listenerCount('Target.receivedMessageFromTarget')).toBe(0);
});

test('missing, wrong-extension, wrong-context, wrong-type and ordinary extension tab never pass', async () => {
  const target = fixture().target;
  for (const targets of [[], [{ ...target, url: url.replace('a'.repeat(32), 'b'.repeat(32)) }], [{ ...target, browserContextId: 'other' }], [{ ...target, type: 'service_worker' }]]) {
    const f = fixture({ targets });
    expect(await readNativePopup(f.context, url, 'true')).toBe(false);
    expect(f.cdp.detach).toHaveBeenCalledOnce();
  }
  expect(await readNativePopup(fixture({ native: false }).context, url, 'true')).toBe(false);
  await expect(passiveNativePopup(fixture({ targets: [target, { ...target, targetId: 'second' }] }).context, url)).rejects.toThrow('ambiguous');
  await expect(passiveNativePopup(fixture().context, url + '?wrong')).rejects.toThrow('invalid');
});

test('missing human outcome and stalled command abort within scoped deadlines', async () => {
  await expect(waitForNativePopup(fixture({ targets: [] }).context, url, 'true', undefined, { timeoutMs: 20, intervalMs: 5 })).rejects.toThrow('outcome not observed');
  const f = fixture({ stall: true });
  await expect(passiveNativePopup(f.context, url, { commandTimeoutMs: 20 })).rejects.toThrow('timed out');
  expect(f.cdp.detach).toHaveBeenCalledOnce();
});
