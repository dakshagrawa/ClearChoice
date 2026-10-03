/* global document, Event */
import { setTimeout, clearTimeout } from 'node:timers';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
// A real action popup has no sender.tab; an extension page in a tab does.
export async function syntheticNativePopup(context, worker, { headless = false } = {}) {
  const url = new URL('/popup/index.html', worker.url()).href;
  const page = context.pages()[0] ?? await context.newPage();
  const title = `ClearChoiceSynthetic-${randomUUID()}`;
  // about:blank may keep Chromium's New Tab title despite document.title.
  // This form-free data page belongs only to the isolated synthetic profile.
  await page.goto(`data:text/html,<title>${title}</title><p>Synthetic catalog evidence only</p>`);
  await page.bringToFront();
  if (!headless) {
    const windows = execFileSync('xdotool', ['search', '--sync', '--name', title], { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
    if (windows.length !== 1) throw new Error('Synthetic browser window is not uniquely identifiable');
    execFileSync('xdotool', ['windowmap', '--sync', windows[0]], { timeout: 5000 });
    execFileSync('xdotool', ['windowfocus', '--sync', windows[0]], { timeout: 5000 });
    await page.waitForFunction(() => document.hasFocus(), undefined, { timeout: 5000 });
  }
  // A new headful profile may have no active OS window. Bind the action to
  // the unique normal window owned by this disposable context, never a guess.
  await worker.evaluate(async () => {
    const windows = await globalThis.chrome.windows.getAll({ windowTypes: ['normal'] });
    if (windows.length !== 1 || !Number.isInteger(windows[0].id)) throw new Error('Synthetic profile must own exactly one normal window');
    const windowId = windows[0].id;
    await globalThis.chrome.windows.update(windowId, { focused: true });
    const current = await globalThis.chrome.windows.get(windowId);
    if (current.type !== 'normal') throw new Error('Synthetic window unavailable');
    await globalThis.chrome.action.openPopup({ windowId });
  });
  const cdp = await context.browser().newBrowserCDPSession();
  let target;
  for (let i = 0; i < 100; i++) {
    target = (await cdp.send('Target.getTargets')).targetInfos.find(item => item.url === url);
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!target) { await cdp.detach(); throw new Error('Synthetic native action popup unavailable'); }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let next = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error('Synthetic popup CDP failure'));
    else entry.resolve(message.result);
  });
  const send = async (method, params) => {
    const id = ++next;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic popup observation timed out')); }, 5000);
      pending.set(id, { resolve, reject, timer });
    });
    try {
      await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
    } catch (error) {
      const entry = pending.get(id);
      pending.delete(id);
      if (entry) { clearTimeout(entry.timer); entry.reject(error); }
    }
    return response;
  };
  const evaluate = async (fn, arg) => {
    const expression = `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`;
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Synthetic popup evaluation failed');
    return result.result?.value;
  };
  return {
    evaluate,
    locator: selector => ({
      count: () => evaluate(selector => document.querySelectorAll(selector).length, selector),
      all: async () => {
        const count = await evaluate(selector => document.querySelectorAll(selector).length, selector);
        return Array.from({ length: count }, (_, index) => ({ click: () => evaluate(({ selector, index }) => document.querySelectorAll(selector)[index].click(), { selector, index }) }));
      },
    }),
    selectOption: (selector, value) => evaluate(({ selector, value }) => {
      const element = document.querySelector(selector);
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value }),
    close: async () => {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Synthetic popup closed')); }
      pending.clear();
      await cdp.detach();
    },
  };
}
