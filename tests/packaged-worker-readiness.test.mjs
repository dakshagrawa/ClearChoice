import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const id = 'a'.repeat(32);
const exact = `chrome-extension://${id}/worker.js`;
let ready;
beforeEach(async () => {
  vi.useFakeTimers();
  ({ waitForPackagedWorker: ready } = await import('../e2e/worker-readiness.ts'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture({ workers = [], send = async () => ({ ok: false, error: 'request-failed' }), create, navigate } = {}) {
  const context = new EventEmitter();
  const messages = [];
  vi.stubGlobal('chrome', { runtime: { id, getManifest: () => ({ background: { service_worker: 'worker.js' } }), sendMessage: message => { messages.push(message); return send(message); } } });
  const worker = (url = exact, evaluate = async (fn, arg) => fn(arg)) => ({ url: () => url, evaluate });
  const page = { goto: vi.fn(async url => { expect(url).toBe(`chrome-extension://${id}/manifest.json`); await navigate?.(); }), evaluate: async (fn, arg) => fn(arg), close: vi.fn(async () => {}) };
  context.serviceWorkers = () => workers;
  context.newPage = async () => { await create?.(); return page; };
  context.isClosed = () => false;
  return { context, page, worker, messages };
}
function clean(f) {
  expect(f.context.listenerCount('serviceworker')).toBe(0);
  expect(f.context.listenerCount('close')).toBe(0);
  expect(f.page.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
}

test('existing exact worker still requires a genuine API and read-only transport handshake', async () => {
  const f = fixture(); const w = f.worker(); f.context.serviceWorkers = () => [w];
  expect(await ready(f.context, id, 100)).toBe(w);
  expect(f.messages).toEqual([{ type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1 }]);
  clean(f);
});

test.each(['during-create', 'during-navigation', 'delayed'])('subscribes before waking and accepts exact worker %s', async mode => {
  let w;
  const emit = () => f.context.emit('serviceworker', w);
  const f = fixture({ create: mode === 'during-create' ? emit : undefined, navigate: mode === 'during-navigation' ? emit : undefined });
  w = f.worker();
  const result = ready(f.context, id, 100);
  void result.catch(() => {});
  if (mode === 'delayed') { await vi.advanceTimersByTimeAsync(30); emit(); }
  expect(await result).toBe(w); clean(f);
});

test('ignores other extension workers and same-extension nonexact URLs', async () => {
  const f = fixture(); const w = f.worker();
  f.context.serviceWorkers = () => [f.worker('chrome-extension://' + 'b'.repeat(32) + '/worker.js'), f.worker(exact + '?other'), f.worker(exact.replace('worker.js', 'other.js'))];
  const result = ready(f.context, id, 100);
  void result.catch(() => {});
  await vi.advanceTimersByTimeAsync(20); f.context.emit('serviceworker', w);
  expect(await result).toBe(w); clean(f);
});

test.each(['missing-worker', 'missing-activation', 'missing-api', 'wrong-id', 'transport-rejected', 'transport-pending', 'unexpected-response', 'navigation', 'closed'])('fails closed and cleans up: %s', async mode => {
  const f = fixture({ send: mode === 'transport-rejected' ? async () => { throw Error('SECRET'); } : mode === 'transport-pending' ? () => new Promise(() => {}) : mode === 'unexpected-response' ? async () => ({ ok: true, records: ['SECRET'] }) : undefined, navigate: mode === 'navigation' ? async () => { throw Error('SECRET'); } : undefined });
  if (mode !== 'missing-worker') f.context.serviceWorkers = () => [f.worker(exact, mode === 'missing-activation' ? () => new Promise(() => {}) : undefined)];
  if (mode === 'wrong-id') globalThis.chrome.runtime.id = 'b'.repeat(32);
  if (mode === 'missing-api') delete globalThis.chrome.runtime.sendMessage;
  const outcome = ready(f.context, id, 100).then(() => 'unexpected-success', error => error.message);
  if (mode === 'closed') f.context.emit('close');
  await vi.advanceTimersByTimeAsync(100);
  const message = await outcome;
  expect(message).toMatch(/^Packaged worker readiness failed: /);
  expect(message).not.toMatch(/SECRET|chrome-extension|records/);
  clean(f);
});

test('observes late rejected evaluations after timeout without leaking listeners or rejections', async () => {
  let reject;
  const f = fixture(); f.context.serviceWorkers = () => [f.worker(exact, () => new Promise((_, j) => { reject = j; }))];
  const outcome = ready(f.context, id, 100).catch(error => error.message);
  await vi.advanceTimersByTimeAsync(100); expect(await outcome).toContain('timeout');
  reject(Error('SECRET')); await vi.advanceTimersByTimeAsync(0); clean(f);
});

test('closes a wake page that arrives after timeout', async () => {
  let release;
  const f = fixture({ create: () => new Promise(r => { release = r; }) });
  const outcome = ready(f.context, id, 100).catch(error => error.message);
  await vi.advanceTimersByTimeAsync(100); expect(await outcome).toContain('timeout');
  release(); await vi.advanceTimersByTimeAsync(0); clean(f);
});


test('waits for delayed worker activation and transport response, rather than target creation', async () => {
  let activate; let respond;
  const f = fixture({ send: () => new Promise(r => { respond = r; }) });
  const w = f.worker(exact, (fn, arg) => new Promise(r => { activate = () => r(fn(arg)); }));
  f.context.serviceWorkers = () => [w];
  let settled = false;
  const result = ready(f.context, id, 100).then(value => { settled = true; return value; });
  void result.catch(() => {});
  await vi.advanceTimersByTimeAsync(20); expect(settled).toBe(false);
  activate(); await vi.advanceTimersByTimeAsync(20); expect(settled).toBe(false);
  respond({ ok: false, error: 'request-failed' });
  expect(await result).toBe(w); clean(f);
});

test.each(['create-rejected', 'create-pending', 'navigate-pending', 'worker-rejected', 'close-rejected', 'close-pending'])('bounds every harness phase: %s', async mode => {
  const f = fixture({ create: mode === 'create-rejected' ? async () => { throw Error('SECRET'); } : mode === 'create-pending' ? () => new Promise(() => {}) : undefined, navigate: mode === 'navigate-pending' ? () => new Promise(() => {}) : undefined });
  f.context.serviceWorkers = () => [f.worker(exact, mode === 'worker-rejected' ? async () => { throw Error('SECRET'); } : undefined)];
  if (mode === 'close-rejected') f.page.close.mockImplementation(async () => { throw Error('SECRET'); });
  if (mode === 'close-pending') f.page.close.mockImplementation(() => new Promise(() => {}));
  const outcome = ready(f.context, id, 100).then(() => 'unexpected-success', error => error.message);
  await vi.advanceTimersByTimeAsync(100);
  expect(await outcome).toMatch(/^Packaged worker readiness failed: /);
  expect(await outcome).not.toContain('SECRET');
  expect(f.context.listenerCount('serviceworker')).toBe(0);
  expect(f.context.listenerCount('close')).toBe(0);
  expect(f.page.close).toHaveBeenCalledTimes(mode.startsWith('create-') ? 0 : 1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['wrong-id', 'missing-api', 'wrong-background'])('checks the worker runtime independently of the wake page: %s', async mode => {
  const f = fixture();
  f.context.serviceWorkers = () => [f.worker(exact, async (fn, arg) => {
    const runtime = globalThis.chrome.runtime;
    try {
      globalThis.chrome.runtime = { ...runtime,
        ...(mode === 'wrong-id' ? { id: 'b'.repeat(32) } : {}),
        ...(mode === 'missing-api' ? { sendMessage: undefined } : {}),
        ...(mode === 'wrong-background' ? { getManifest: () => ({ background: { service_worker: 'other.js' } }) } : {}),
      };
      return fn(arg);
    } finally { globalThis.chrome.runtime = runtime; }
  })];
  const outcome = ready(f.context, id, 100).then(() => 'unexpected-success', error => error.message);
  await vi.advanceTimersByTimeAsync(100);
  expect(await outcome).toContain('"workerLoaded":false'); clean(f);
});

test('observes a late rejected sendMessage after the bounded handshake expires', async () => {
  let reject;
  const f = fixture({ send: () => new Promise((_, j) => { reject = j; }) });
  f.context.serviceWorkers = () => [f.worker()];
  const outcome = ready(f.context, id, 100).catch(error => error.message);
  await vi.advanceTimersByTimeAsync(100); expect(await outcome).toContain('timeout');
  reject(Error('SECRET')); await vi.advanceTimersByTimeAsync(0); clean(f);
});
