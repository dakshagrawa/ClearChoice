import type { BrowserContext, Page, Worker } from 'playwright/test';

// Transport readiness only. An untrusted tab's rejection does not establish that
// application stores initialized successfully; genuine popup callers own that check.
export async function waitForPackagedWorker(context: BrowserContext, extensionId: string, timeoutMs = 10_000): Promise<Worker> {
  const diagnostics = { phase: 'setup', targetCreated: false, workerEvents: 0, exactWorker: false, workerLoaded: false, transport: 'pending', wakeClosed: false };
  const failure = (reason: string) => Error(`Packaged worker readiness failed: ${JSON.stringify({ reason, ...diagnostics })}`);
  if (!/^[a-p]{32}$/.test(extensionId) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure('invalid-input');
  const deadline = Date.now() + timeoutMs;
  let stopped = false;
  let stopReason = '';
  let stop!: (reason: string) => void;
  const ended = new Promise<string>(resolve => { stop = reason => { if (!stopReason) stopReason = reason; resolve(reason); }; });
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([
    operation,
    ended.then(reason => { throw failure(reason); }),
  ]);
  const onClose = () => stop('context-closed');
  let select!: (worker: Worker | undefined) => void;
  const selected = new Promise<Worker | undefined>(resolve => { select = resolve; });
  const exactUrl = `chrome-extension://${extensionId}/worker.js`;
  const onWorker = (worker: Worker) => {
    diagnostics.workerEvents++;
    if (worker.url() === exactUrl) { diagnostics.exactWorker = true; select(worker); }
  };
  let wake: Page | undefined;
  let closing: Promise<void> | undefined;
  const close = (page: Page) => closing ??= page.close().then(() => { diagnostics.wakeClosed = true; });
  context.on('close', onClose);
  context.on('serviceworker', onWorker);
  try {
    for (const worker of context.serviceWorkers()) {
      if (worker.url() === exactUrl) { diagnostics.exactWorker = true; select(worker); break; }
    }
    diagnostics.phase = 'create-page';
    await bounded(context.newPage().then(async page => {
      diagnostics.targetCreated = true;
      if (stopped) { await close(page); throw failure('late-page'); }
      wake = page;
    }));
    if (!wake) throw failure('missing-page');
    diagnostics.phase = 'navigate';
    // A packaged, script-free document: no popup startup messages, trusted popup
    // sender, permissions, seed data, or new production endpoint.
    await bounded(wake.goto(`chrome-extension://${extensionId}/manifest.json`, { timeout: Math.max(1, deadline - Date.now()), waitUntil: 'domcontentloaded' }));
    diagnostics.phase = 'handshake';
    const loaded = bounded(selected).then(async worker => {
      if (!worker) throw failure('cancelled');
      const valid = await bounded(worker.evaluate(expectedId => {
        const background = typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.().background;
        return typeof chrome !== 'undefined' && chrome.runtime?.id === expectedId
        && typeof chrome.runtime.getManifest === 'function'
        && typeof chrome.runtime.sendMessage === 'function'
        && !!background && 'service_worker' in background && background.service_worker === 'worker.js';
      }, extensionId));
      if (!valid) throw failure('worker-api');
      diagnostics.workerLoaded = true;
      return worker;
    });
    const transport = bounded(wake.evaluate(async ({ expectedId, budget }) => {
      if (typeof chrome === 'undefined' || chrome.runtime?.id !== expectedId
        || typeof chrome.runtime.sendMessage !== 'function') return 'missing-api';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // This read-only request must remain untrusted. A rejected *response*
        // proves a listener replied; a rejected sendMessage promise does not.
        const response: unknown = await Promise.race([
          chrome.runtime.sendMessage({ type: 'CLEARCHOICE_SUBSCRIPTION_LIST', version: 1 }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), budget); }),
        ]);
        return response !== null && typeof response === 'object'
          && 'ok' in response && response.ok === false
          && 'error' in response && response.error === 'request-failed'
          ? 'untrusted-response' : 'unexpected-response';
      } catch { return 'send-rejected'; }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }, { expectedId: extensionId, budget: Math.max(1, deadline - Date.now()) })).then(result => {
      diagnostics.transport = result;
      if (result !== 'untrusted-response') throw failure('transport');
    });
    const [worker] = await bounded(Promise.all([loaded, transport]));
    diagnostics.phase = 'close-page';
    await bounded(close(wake));
    wake = undefined;
    return worker;
  } catch {
    // Never include Playwright errors, fixture URLs, response data, or raw state.
    throw failure(stopReason || (Date.now() >= deadline ? 'timeout' : diagnostics.phase === 'handshake' ? 'handshake' : 'setup'));
  } finally {
    stopped = true;
    select(undefined);
    context.off('serviceworker', onWorker);
    context.off('close', onClose);
    // All races have rejection observers. Resolve the cancellation promise too,
    // including on success, so event/handshake continuations cannot be orphaned.
    stop('finished');
    clearTimeout(timer);
    if (wake) await Promise.race([close(wake).catch(() => {}), ended]);
  }
}
