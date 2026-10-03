/* global chrome, location */
import { EventEmitter } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';

// Observation only: never opens/focuses a popup or dispatches user input. The
// caller supplies the complete reviewed extension URL, not a path suffix.
export async function passiveNativePopup(context, url, { commandTimeoutMs = 5_000 } = {}) {
  if (!/^chrome-extension:\/\/[a-p]{32}\/popup\/index\.html$/.test(url)) throw new Error('invalid reviewed popup URL');
  const anchor = context.pages().find(page => !page.isClosed());
  if (!anchor) throw new Error('popup observation context unavailable');
  const anchorSession = await context.newCDPSession(anchor);
  let contextId;
  try { contextId = (await anchorSession.send('Target.getTargetInfo')).targetInfo.browserContextId; }
  finally { await anchorSession.detach(); }
  if (!contextId) throw new Error('popup observation context identity unavailable');
  const cdp = await context.browser().newBrowserCDPSession();
  let sessionId;
  let closed = false;
  let next = 0;
  const pending = new Map();
  const events = new EventEmitter();
  const failPending = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('native popup target closed')); }
    pending.clear();
  };
  const received = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.method) { events.emit(message.method, message.params); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error('native popup observation failed'));
    else entry.resolve(message.result);
  };
  const detached = event => {
    if (event.sessionId === sessionId) { closed = true; failPending(); }
  };
  cdp.on('Target.receivedMessageFromTarget', received);
  cdp.on('Target.detachedFromTarget', detached);
  const close = async () => {
    closed = true;
    failPending();
    cdp.off('Target.receivedMessageFromTarget', received);
    cdp.off('Target.detachedFromTarget', detached);
    events.removeAllListeners();
    await cdp.detach();
  };
  try {
    const targets = (await cdp.send('Target.getTargets')).targetInfos.filter(item => item.url === url && item.type === 'page' && item.browserContextId === contextId);
    if (!targets.length) { await close(); return null; }
    if (targets.length !== 1) throw new Error('reviewed popup target is ambiguous');
    const targetId = targets[0].targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false }));
    const send = async (method, params = {}) => {
      if (!['Runtime.evaluate', 'Page.enable'].includes(method)) throw new Error('non-observation popup command refused');
      if (closed) throw new Error('native popup target closed');
      const id = ++next;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('native popup observation timed out')); }, commandTimeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
      // Attach a handler before awaiting the transport: target closure can reject
      // the response while sendMessageToTarget is still settling.
      const transport = cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => {
        const entry = pending.get(id);
        pending.delete(id);
        if (entry) { clearTimeout(entry.timer); entry.reject(new Error('native popup transport unavailable')); }
      });
      const [result] = await Promise.all([response, transport]);
      return result;
    };
    const assertTarget = async () => {
      if (closed) throw new Error('native popup target closed');
      const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId });
      if (targetInfo.targetId !== targetId || targetInfo.url !== url || targetInfo.type !== 'page' || targetInfo.browserContextId !== contextId) throw new Error('native popup target changed');
    };
    const evaluate = async (fn, arg) => {
      await assertTarget();
      const expression = typeof fn === 'string' ? fn : `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error('native popup evaluation failed');
      await assertTarget();
      return result.result?.value;
    };
    // An extension tab at this same URL is NOT a genuine action popup.
    if (await evaluate(async expected => location.href === expected && chrome.runtime.getURL('popup/index.html') === expected && await chrome.tabs.getCurrent() === undefined, url) !== true) {
      await close(); return null;
    }
    const session = { send, on: (...args) => events.on(...args), off: (...args) => events.off(...args), detach: close };
    return { evaluate, session, isClosed: () => closed, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

// Reacquire only for independent UI samples. A dialog observer retains its exact
// target/session instead, so reopening cannot satisfy an old click checkpoint.
export async function readNativePopup(context, url, predicate, arg) {
  const popup = await passiveNativePopup(context, url);
  if (!popup) return false;
  try { return await popup.evaluate(predicate, arg) === true; }
  finally { await popup.close(); }
}

export async function waitForNativePopup(context, url, predicate, arg, { timeoutMs = 300_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await readNativePopup(context, url, predicate, arg)) return true;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error('human native popup outcome not observed within five-minute checkpoint');
}
