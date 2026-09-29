import { afterEach, expect, it, vi } from 'vitest';

function installChrome(): { addListener: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } {
  const addListener = vi.fn();
  const sendMessage = vi.fn().mockImplementation(async (message: { type: string }) => message.type === 'CLEARCHOICE_DISMISSED_GET' ? { ok: true, dismissed: false } : message.type === 'CLEARCHOICE_DISMISSED_SET' ? { ok: true } : { ok: true, findingCount: 0 });
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension', onMessage: { addListener }, sendMessage },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ dismissed: false }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
  return { addListener, sendMessage };
}

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.resetModules();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.querySelector('[data-clearchoice-panel]')?.remove();
  delete (window as Window & { __clearchoiceContentListenerInstalled__?: true }).__clearchoiceContentListenerInstalled__;
});

function autoChrome() {
  const installed = installChrome();
  installed.sendMessage.mockImplementation(async (message: { type: string; batch?: { findings: unknown[] } }) => {
    if (message.type === 'CLEARCHOICE_AUTO_STATUS') return { ok: true, generation: 3 };
    if (message.type === 'CLEARCHOICE_AUTO_SUBMIT') return { ok: true, findingCount: message.batch?.findings.length };
    if (message.type === 'CLEARCHOICE_DISMISSED_GET') return { ok: true, dismissed: false };
    if (message.type === 'CLEARCHOICE_DISMISSED_SET') return { ok: true };
    return { ok: false, error: 'request-failed' };
  });
  return installed;
}

const betaCheckout = '<main><aside>Order summary — Subtotal: $24</aside><section>Membership renews automatically for $12 per month until cancelled.</section><button>Place order</button></main>';
const automaticSubmits = (sendMessage: ReturnType<typeof vi.fn>) => sendMessage.mock.calls.filter(([message]) => message.type === 'CLEARCHOICE_AUTO_SUBMIT');
const ownedPanel = () => Array.from(document.querySelectorAll<HTMLElement>('[data-clearchoice-panel]')).find((panel) => panel.shadowRoot?.querySelector('.clearchoice-panel'));

it('restarts an active observer after failed exact-document disable and scans at the new generation', async () => {
  const { addListener, sendMessage } = autoChrome();
  let generation = 3;
  sendMessage.mockImplementation(async (message: { type: string; batch?: { findings: unknown[] } }) => {
    if (message.type === 'CLEARCHOICE_AUTO_STATUS') return { ok: true, generation };
    if (message.type === 'CLEARCHOICE_AUTO_SUBMIT') return { ok: true, findingCount: message.batch?.findings.length };
    return { ok: true, dismissed: false };
  });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(automaticSubmits(sendMessage)).toHaveLength(1));
  generation = 5; // The exact-document DISABLE message failed; no content message was received.
  const listener = addListener.mock.calls[0][0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean | undefined;
  const reply = vi.fn();
  expect(listener({ type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 5 }, { id: 'extension' }, reply)).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
  await vi.waitFor(() => expect(automaticSubmits(sendMessage)).toHaveLength(2));
  expect(automaticSubmits(sendMessage)[1][0].generation).toBe(5);
  expect(addListener).toHaveBeenCalledTimes(1);
});

it('restarts during an old in-flight submit and keeps each challenge scoped to its pending request', async () => {
  const { addListener, sendMessage } = autoChrome();
  let generation = 3;
  const finish = new Map<number, (value: unknown) => void>();
  sendMessage.mockImplementation((message: { type: string; generation?: number; batch?: { findings: unknown[] } }) => {
    if (message.type === 'CLEARCHOICE_AUTO_STATUS') return Promise.resolve({ ok: true, generation });
    if (message.type === 'CLEARCHOICE_AUTO_SUBMIT') return new Promise((resolve) => { finish.set(message.generation!, resolve); });
    return Promise.resolve({ ok: true, dismissed: false });
  });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(automaticSubmits(sendMessage)).toHaveLength(1));
  const listener = addListener.mock.calls[0][0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const oldId = automaticSubmits(sendMessage)[0][0].batch.requestId as string;
  generation = 5; // DISABLE was lost; the old worker receipt remains pending.
  const started = vi.fn();
  listener({ type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 5 }, { id: 'extension' }, started);
  await vi.waitFor(() => expect(started).toHaveBeenCalledWith({ ok: true }));
  await vi.waitFor(() => expect(automaticSubmits(sendMessage)).toHaveLength(2));
  const next = automaticSubmits(sendMessage)[1][0];
  expect(next.generation).toBe(5);
  expect(next.batch.requestId).not.toBe(oldId);
  const challenge = (requestId: string, nonce: string, senderId = 'extension') => {
    const reply = vi.fn();
    listener({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE', version: 1, requestId, nonce }, { id: senderId }, reply);
    return reply;
  };
  expect(challenge(oldId, 'old-nonce')).toHaveBeenCalledWith({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: oldId, nonce: 'old-nonce' });
  expect(challenge(next.batch.requestId, 'new-nonce')).toHaveBeenCalledWith({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: next.batch.requestId, nonce: 'new-nonce' });
  expect(challenge('unrelated', 'wrong-nonce')).toHaveBeenCalledWith({ ok: false, error: 'request-failed' });
  expect(challenge(next.batch.requestId, 'wrong-sender', 'other')).toHaveBeenCalledWith({ ok: false, error: 'request-failed' });
  finish.get(3)!({ ok: true, findingCount: 1 });
  await vi.waitFor(() => expect(challenge(oldId, 'late')).toHaveBeenCalledWith({ ok: false, error: 'request-failed' }));
  expect(challenge(next.batch.requestId, 'still-pending')).toHaveBeenCalledWith({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: next.batch.requestId, nonce: 'still-pending' });
  expect(ownedPanel()).toBeUndefined();
  finish.get(5)!({ ok: true, findingCount: next.batch.findings.length });
  await vi.waitFor(() => expect(ownedPanel()?.shadowRoot?.querySelectorAll('article')).toHaveLength(1));
  expect(challenge(next.batch.requestId, 'late')).toHaveBeenCalledWith({ ok: false, error: 'request-failed' });
  expect(addListener).toHaveBeenCalledTimes(1);
});

it('enable-now supersedes a pending denied bootstrap instead of losing the restart', async () => {
  const { addListener, sendMessage } = autoChrome();
  let deny!: (response: unknown) => void;
  sendMessage.mockImplementationOnce(() => new Promise((resolve) => { deny = resolve; }));
  document.body.innerHTML = betaCheckout;
  await import('./index');
  const listener = addListener.mock.calls[0][0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const reply = vi.fn();
  listener({ type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 3 }, { id: 'extension' }, reply);
  deny({ ok: false, error: 'request-failed' });
  await vi.waitFor(() => expect(ownedPanel()).toBeDefined());
  expect(automaticSubmits(sendMessage)).toHaveLength(1);
  expect(addListener).toHaveBeenCalledTimes(1);
});

it('a denied initial status can be restarted by a worker-targeted enable without duplicate listeners', async () => {
  const { addListener, sendMessage } = autoChrome();
  sendMessage.mockResolvedValueOnce({ ok: false, error: 'request-failed' });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_AUTO_STATUS' }));
  const listener = addListener.mock.calls[0][0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean | undefined;
  const rejected = vi.fn();
  expect(listener({ type: 'CLEARCHOICE_AUTO_START', extra: 'unsafe' }, { id: 'extension' }, rejected)).toBeUndefined();
  const reply = vi.fn();
  expect(listener({ type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 3 }, { id: 'extension' }, reply)).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
  await vi.waitFor(() => expect(ownedPanel()).toBeDefined());
  expect(addListener).toHaveBeenCalledTimes(1);
  listener({ type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 3 }, { id: 'extension' }, vi.fn());
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(automaticSubmits(sendMessage)).toHaveLength(1);
});

it('BFCache pageshow reauthorizes and resumes once, but a revoked restore leaves no panel', async () => {
  const { addListener, sendMessage } = autoChrome();
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(ownedPanel()).toBeDefined());
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(ownedPanel()).toBeUndefined();
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await vi.waitFor(() => expect(ownedPanel()).toBeDefined());
  expect(addListener).toHaveBeenCalledTimes(1);
  const submissions = automaticSubmits(sendMessage).length;
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(automaticSubmits(sendMessage)).toHaveLength(submissions);
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  sendMessage.mockImplementation(async (message: { type: string }) => message.type === 'CLEARCHOICE_AUTO_STATUS'
    ? { ok: false, error: 'request-failed' } : { ok: true, dismissed: false });
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(ownedPanel()).toBeUndefined();
  expect(automaticSubmits(sendMessage)).toHaveLength(submissions);
});

it('denied or ambiguous status never installs an automatic scan or panel', async () => {
  const { sendMessage } = autoChrome();
  sendMessage.mockResolvedValueOnce({ ok: false, error: 'request-failed' });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_AUTO_STATUS' }));
  document.body.append(document.createElement('p'));
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(automaticSubmits(sendMessage)).toHaveLength(0);
  expect(ownedPanel()).toBeUndefined();
});

it('a delayed denied status does not erase a manually requested Analyze panel', async () => {
  const { addListener, sendMessage } = installChrome();
  let deny!: (response: unknown) => void;
  sendMessage.mockImplementation((message: { type: string }) => message.type === 'CLEARCHOICE_AUTO_STATUS'
    ? new Promise((resolve) => { deny = resolve; })
    : Promise.resolve(message.type === 'CLEARCHOICE_DISMISSED_GET' ? { ok: true, dismissed: false } : { ok: true }));
  document.body.innerHTML = betaCheckout;
  await import('./index');
  const listener = addListener.mock.calls[0][0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const reply = vi.fn();
  listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
  deny({ ok: false, error: 'request-failed' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(ownedPanel()).toBeDefined();
});

it('a transient submit refusal gets at most one fresh scan and then displays persisted findings', async () => {
  const { sendMessage } = autoChrome();
  let attempts = 0;
  sendMessage.mockImplementation(async (message: { type: string; batch?: { findings: unknown[] } }) => {
    if (message.type === 'CLEARCHOICE_AUTO_STATUS') return { ok: true, generation: 3 };
    if (message.type === 'CLEARCHOICE_AUTO_SUBMIT') return ++attempts === 1
      ? { ok: false, error: 'retryable-failure' } : { ok: true, findingCount: message.batch?.findings.length };
    return { ok: true, dismissed: false };
  });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(ownedPanel()?.shadowRoot?.querySelectorAll('article')).toHaveLength(1));
  expect(automaticSubmits(sendMessage)).toHaveLength(2);
  expect(automaticSubmits(sendMessage)[0][0].batch.requestId).not.toBe(automaticSubmits(sendMessage)[1][0].batch.requestId);
});

it('a deterministic submit refusal never retries or displays findings', async () => {
  const { sendMessage } = autoChrome();
  sendMessage.mockImplementation(async (message: { type: string }) => message.type === 'CLEARCHOICE_AUTO_STATUS'
    ? { ok: true, generation: 3 } : { ok: false, error: 'request-failed' });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(automaticSubmits(sendMessage)).toHaveLength(1));
  document.body.append(document.createElement('span'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(automaticSubmits(sendMessage)).toHaveLength(1);
  expect(ownedPanel()).toBeUndefined();
});

it('status with a positive generation plus extra fields fails closed', async () => {
  const { sendMessage } = autoChrome();
  sendMessage.mockResolvedValueOnce({ ok: true, generation: 3, origin: 'https://unexpected.example' });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await new Promise((resolve) => setTimeout(resolve, 140));
  expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(['CLEARCHOICE_AUTO_STATUS']);
  expect(ownedPanel()).toBeUndefined();
});

it('valid opt-in initially scans, but unsupported and supported zero-finding pages show no panel', async () => {
  const { sendMessage } = autoChrome();
  document.body.innerHTML = '<main>Account settings</main>';
  await import('./index');
  await new Promise((resolve) => setTimeout(resolve, 140));
  expect(automaticSubmits(sendMessage)).toHaveLength(0);
  document.body.innerHTML = '<main><aside>Order summary — Subtotal: $24</aside><button>Place order</button></main>';
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(automaticSubmits(sendMessage)).toHaveLength(0);
  expect(ownedPanel()).toBeUndefined();
});

it('automatically persists inserted screened findings once and renders only the persisted excerpt despite DOM churn', async () => {
  const { sendMessage } = autoChrome();
  document.body.innerHTML = '<main><aside>Order summary — Subtotal: $24</aside><button>Place order</button></main>';
  await import('./index');
  document.querySelector('main')?.insertAdjacentHTML('beforeend', '<section>Membership renews automatically for $12 per month until cancelled.</section>');
  await vi.waitFor(() => expect(automaticSubmits(sendMessage)).toHaveLength(1));
  await vi.waitFor(() => expect(ownedPanel()?.shadowRoot?.querySelectorAll('article')).toHaveLength(1));
  const excerpt = automaticSubmits(sendMessage)[0][0].batch.findings[0].screenedExcerpt;
  expect(ownedPanel()?.shadowRoot?.querySelector('.evidence')?.textContent).toBe(excerpt);
  for (let i = 0; i < 12; i++) document.querySelector('main')?.append(document.createElement('span'));
  await new Promise((resolve) => setTimeout(resolve, 240));
  expect(automaticSubmits(sendMessage)).toHaveLength(1);
  expect(document.querySelectorAll('[data-clearchoice-panel]')).toHaveLength(1);
});

it('rejects sensitive candidates, then removes the panel on SPA exit and does not resubmit after exit', async () => {
  const { sendMessage } = autoChrome();
  document.body.innerHTML = betaCheckout.replace('</main>', '<section>Membership renews automatically for $12 per month. example.com/private?token=secret</section></main>');
  await import('./index');
  await vi.waitFor(() => expect(ownedPanel()).toBeDefined());
  expect(ownedPanel()?.shadowRoot?.textContent).not.toContain('example.com/private');
  document.body.innerHTML = '<main>Account settings</main>';
  await vi.waitFor(() => expect(ownedPanel()).toBeUndefined());
  const count = automaticSubmits(sendMessage).length;
  document.body.append(document.createElement('span'));
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(automaticSubmits(sendMessage)).toHaveLength(count);
});

it('revocation while submit is pending cannot paint a stale panel', async () => {
  const { addListener, sendMessage } = autoChrome();
  let finish!: (reply: unknown) => void;
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'CLEARCHOICE_AUTO_STATUS') return { ok: true, generation: 3 };
    if (message.type === 'CLEARCHOICE_AUTO_SUBMIT') return new Promise((resolve) => { finish = resolve; });
    return { ok: true, dismissed: false };
  });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(automaticSubmits(sendMessage)).toHaveLength(1));
  const listener = addListener.mock.calls[0][0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const reply = vi.fn();
  listener({ type: 'CLEARCHOICE_DISABLE' }, {}, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
  finish({ ok: true, findingCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(ownedPanel()).toBeUndefined();
});

it('a worker status revoked after a successful submit prevents stale rendering', async () => {
  const { sendMessage } = autoChrome();
  let checks = 0;
  sendMessage.mockImplementation(async (message: { type: string; batch?: { findings: unknown[] } }) => {
    if (message.type === 'CLEARCHOICE_AUTO_STATUS') return ++checks < 3 ? { ok: true, generation: 3 } : { ok: false, error: 'request-failed' };
    if (message.type === 'CLEARCHOICE_AUTO_SUBMIT') return { ok: true, findingCount: message.batch?.findings.length };
    return { ok: true, dismissed: false };
  });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(automaticSubmits(sendMessage)).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 140));
  expect(ownedPanel()).toBeUndefined();
  expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CLEARCHOICE_DISMISSED_GET')).toHaveLength(0);
});

it('revocation during dismissal lookup still prevents a stale panel', async () => {
  const { sendMessage } = autoChrome();
  let approved = true;
  sendMessage.mockImplementation(async (message: { type: string; batch?: { findings: unknown[] } }) => {
    if (message.type === 'CLEARCHOICE_AUTO_STATUS') return approved ? { ok: true, generation: 3 } : { ok: false, error: 'request-failed' };
    if (message.type === 'CLEARCHOICE_AUTO_SUBMIT') return { ok: true, findingCount: message.batch?.findings.length };
    if (message.type === 'CLEARCHOICE_DISMISSED_GET') { approved = false; return { ok: true, dismissed: false }; }
    return { ok: false, error: 'request-failed' };
  });
  document.body.innerHTML = betaCheckout;
  await import('./index');
  await vi.waitFor(() => expect(sendMessage.mock.calls.some(([message]) => message.type === 'CLEARCHOICE_DISMISSED_GET')).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 130));
  expect(ownedPanel()).toBeUndefined();
});

it('automatic scanning uses worker messages only, never page network or direct storage', async () => {
  const { sendMessage } = autoChrome();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'send');
  try {
    document.body.innerHTML = betaCheckout;
    await import('./index');
    await vi.waitFor(() => expect(ownedPanel()).toBeDefined());
    expect(automaticSubmits(sendMessage)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    const message = automaticSubmits(sendMessage)[0][0];
    expect(Object.keys(message).sort()).toEqual(['batch', 'generation', 'type', 'version']);
    expect(JSON.stringify(message)).not.toContain(location.href);
  } finally {
    fetchSpy.mockRestore();
    xhrSpy.mockRestore();
  }
});

it('dismissed overflow diagnostic stays hidden during subsequent DOM churn', async () => {
  const { sendMessage } = autoChrome();
  document.body.innerHTML = '<main><aside>Order summary — Subtotal: $24</aside><button>Place order</button></main>';
  for (let i = 0; i < 101; i++) document.querySelector('main')?.insertAdjacentHTML('beforeend', '<label><input type="checkbox" checked> Add protection for $5 per month</label>');
  await import('./index');
  await vi.waitFor(() => expect(ownedPanel()?.shadowRoot?.textContent).toContain('could not be saved'));
  ownedPanel()?.shadowRoot?.querySelector<HTMLButtonElement>('[data-clearchoice-dismiss]')?.click();
  await vi.waitFor(() => expect(sendMessage.mock.calls.some(([message]) => message.type === 'CLEARCHOICE_DISMISSED_SET')).toBe(true));
  sendMessage.mockImplementation(async (message: { type: string }) => message.type === 'CLEARCHOICE_AUTO_STATUS'
    ? { ok: true, generation: 3 } : message.type === 'CLEARCHOICE_DISMISSED_GET'
      ? { ok: true, dismissed: true } : { ok: false, error: 'request-failed' });
  document.querySelector('main')?.append(document.createElement('span'));
  await new Promise((resolve) => setTimeout(resolve, 170));
  expect(ownedPanel()).toBeUndefined();
  expect(automaticSubmits(sendMessage)).toHaveLength(0);
});

it('overflow reports a non-success diagnostic without submitting or showing a partial panel', async () => {
  const { sendMessage } = autoChrome();
  document.body.innerHTML = '<main><aside>Order summary — Subtotal: $24</aside><button>Place order</button></main>';
  for (let i = 0; i < 101; i++) document.querySelector('main')?.insertAdjacentHTML('beforeend', `<label><input type="checkbox" checked> Add protection for $${i + 1} per month</label>`);
  await import('./index');
  await new Promise((resolve) => setTimeout(resolve, 260));
  expect(automaticSubmits(sendMessage)).toHaveLength(0);
  expect(ownedPanel()?.shadowRoot?.textContent).toContain('could not be saved');
  expect(ownedPanel()?.shadowRoot?.querySelectorAll('article')).toHaveLength(0);
});

function setSupportedCheckoutContext(): void {
  document.body.innerHTML = '<main><aside>Order summary — Subtotal: $24</aside><button>Place order</button></main>';
}

it('does not scan or answer an unsolicited automatic document challenge', async () => {
  const { addListener, sendMessage } = installChrome();
  setSupportedCheckoutContext();
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const reply = vi.fn();
  expect(listener({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE', version: 1, requestId: 'auto-1', nonce: 'nonce-1' }, {}, reply)).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: 'request-failed' }));
  expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(['CLEARCHOICE_AUTO_STATUS']);
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
});

it('attests only the matching in-flight automatic observation without scanning', async () => {
  const { addListener, sendMessage } = installChrome();
  setSupportedCheckoutContext();
  const { submitAutomaticObservation } = await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  let complete!: (value: unknown) => void;
  sendMessage.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH' as const, version: 1 as const, requestId: 'auto-1', findings: [] };
  const submission = submitAutomaticObservation(1, batch);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_AUTO_SUBMIT', version: 1, generation: 1, batch }));
  const request = { type: 'CLEARCHOICE_FINDINGS_CHALLENGE', version: 1, requestId: 'auto-1', nonce: 'nonce-1' };
  const reply = vi.fn();
  listener(request, { id: 'other' }, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: 'request-failed' }));
  const valid = vi.fn();
  listener({ ...request, requestId: 'other' }, { id: 'extension' }, valid);
  await vi.waitFor(() => expect(valid).toHaveBeenCalledWith({ ok: false, error: 'request-failed' }));
  const attested = vi.fn();
  listener(request, { id: 'extension' }, attested);
  await vi.waitFor(() => expect(attested).toHaveBeenCalledWith({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: 'auto-1', nonce: 'nonce-1' }));
  expect(sendMessage.mock.calls.filter(([message]) => message.type === 'CLEARCHOICE_AUTO_SUBMIT')).toHaveLength(1);
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
  complete({ ok: true, findingCount: 0 });
  await expect(submission).resolves.toEqual({ ok: true, findingCount: 0 });
  const late = vi.fn();
  listener(request, { id: 'extension' }, late);
  await vi.waitFor(() => expect(late).toHaveBeenCalledWith({ ok: false, error: 'request-failed' }));
});

it('rejects duplicate request IDs and bounds simultaneous automatic challenges', async () => {
  const { addListener, sendMessage } = installChrome();
  const { submitAutomaticObservation } = await import('./index');
  const listener = addListener.mock.calls[0][0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const pending = new Map<string, (value: unknown) => void>();
  sendMessage.mockImplementation((message: { type: string; batch?: { requestId: string } }) => message.type === 'CLEARCHOICE_AUTO_SUBMIT'
    ? new Promise((resolve) => { pending.set(message.batch!.requestId, resolve); }) : Promise.resolve({ ok: false, error: 'request-failed' }));
  const batch = (requestId: string) => ({ type: 'CLEARCHOICE_FINDINGS_BATCH' as const, version: 1 as const, requestId, findings: [] });
  const first = submitAutomaticObservation(3, batch('auto-first'));
  await expect(submitAutomaticObservation(3, batch('auto-first'))).rejects.toThrow('Automatic observation unavailable');
  const second = submitAutomaticObservation(5, batch('auto-second'));
  await expect(submitAutomaticObservation(7, batch('auto-third'))).rejects.toThrow('Automatic observation unavailable');
  expect(automaticSubmits(sendMessage)).toHaveLength(2);
  const challenge = vi.fn();
  listener({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE', version: 1, requestId: 'auto-third', nonce: 'nonce' }, { id: 'extension' }, challenge);
  expect(challenge).toHaveBeenCalledWith({ ok: false, error: 'request-failed' });
  pending.get('auto-first')!({ ok: true, findingCount: 0 });
  await expect(first).resolves.toEqual({ ok: true, findingCount: 0 });
  const third = submitAutomaticObservation(7, batch('auto-third'));
  expect(automaticSubmits(sendMessage)).toHaveLength(3);
  pending.get('auto-second')!({ ok: true, findingCount: 0 });
  pending.get('auto-third')!({ ok: true, findingCount: 0 });
  await expect(second).resolves.toEqual({ ok: true, findingCount: 0 });
  await expect(third).resolves.toEqual({ ok: true, findingCount: 0 });
});

it('exposes a structured retryable signal to the future automatic observer', async () => {
  const { sendMessage } = installChrome();
  const { submitAutomaticObservation } = await import('./index');
  const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH' as const, version: 1 as const, requestId: 'auto-retry', findings: [] };
  sendMessage.mockResolvedValueOnce({ ok: false, error: 'retryable-failure' });
  await expect(submitAutomaticObservation(1, batch)).rejects.toMatchObject({ retryable: true });
  sendMessage.mockResolvedValueOnce({ ok: false, error: 'request-failed' });
  await expect(submitAutomaticObservation(1, batch)).rejects.toMatchObject({ retryable: false });
});

it('marks a worker messaging interruption as retryable', async () => {
  const { sendMessage } = installChrome();
  const { submitAutomaticObservation } = await import('./index');
  sendMessage.mockRejectedValueOnce(new Error('worker restarted'));
  const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH' as const, version: 1 as const, requestId: 'auto-restart', findings: [] };
  await expect(submitAutomaticObservation(1, batch)).rejects.toMatchObject({ retryable: true });
});

it('disable removes the current owned panel without scanning or changing dismissal and rejects extra fields', async () => {
  const { addListener, sendMessage } = installChrome();
  setSupportedCheckoutContext();
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean | undefined;
  const reply = vi.fn();
  listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, reply);
  await vi.waitFor(() => expect(document.querySelector('[data-clearchoice-panel]')).not.toBeNull());
  sendMessage.mockClear();
  expect(listener({ type: 'CLEARCHOICE_DISABLE', extra: 'private' }, {}, reply)).toBeUndefined();
  expect(document.querySelector('[data-clearchoice-panel]')).not.toBeNull();
  const disabled = vi.fn();
  expect(listener({ type: 'CLEARCHOICE_DISABLE' }, {}, disabled)).toBe(true);
  await vi.waitFor(() => expect(disabled).toHaveBeenCalledWith({ ok: true }));
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
});

it('routes dismissed state through worker and never calls content storage', async () => {
  const { addListener, sendMessage } = installChrome();
  setSupportedCheckoutContext();
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const reply = vi.fn();
  listener({ type: 'CLEARCHOICE_ANALYZE', requestId: 'req1', nonce: 'nonce1' }, {}, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalled());
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_DISMISSED_GET' });
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'CLEARCHOICE_SUBMIT', nonce: 'nonce1' }));
  expect(chrome.storage.local.get).not.toHaveBeenCalled();
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
});

it('rejects a malformed batch receipt and does not render or report success', async () => {
  const { addListener, sendMessage } = installChrome();
  sendMessage.mockImplementation(async (message: { type: string }) => message.type === 'CLEARCHOICE_SUBMIT'
    ? { ok: true, findingCount: 1 }
    : message.type === 'CLEARCHOICE_DISMISSED_GET' ? { ok: true, dismissed: false }
      : { ok: false, error: 'request-failed' });
  setSupportedCheckoutContext();
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const reply = vi.fn();
  listener({ type: 'CLEARCHOICE_ANALYZE', requestId: 'req1', nonce: 'nonce1' }, {}, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: 'request-failed' }));
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
});

it('reports only persisted eligible findings when checkout evidence is screened out', async () => {
  const { addListener, sendMessage } = installChrome();
  document.body.innerHTML = '<main><aside>Order summary — Subtotal: $24</aside><section>Membership renews automatically every month for $12. example.com/checkout?token=private</section><button>Place order</button></main>';
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
  const reply = vi.fn();
  listener({ type: 'CLEARCHOICE_ANALYZE', requestId: 'req1', nonce: 'nonce1' }, {}, reply);
  await vi.waitFor(() => expect(reply).toHaveBeenCalled());
  const submission = sendMessage.mock.calls.find(([message]) => message.type === 'CLEARCHOICE_SUBMIT')?.[0];
  expect(submission?.batch.findings).toHaveLength(0);
  expect(reply).toHaveBeenCalledWith({ ok: true, status: 'supported', findingCount: 0 });
  const panel = document.querySelector<HTMLElement>('[data-clearchoice-panel]');
  expect(panel?.shadowRoot?.querySelectorAll('article')).toHaveLength(0);
  expect(panel?.shadowRoot?.textContent).not.toContain('example.com/checkout');
});

it('registers one listener and renders one panel when the payload is injected repeatedly', async () => {
  const { addListener } = installChrome();
  setSupportedCheckoutContext();

  await import('./index');
  await import('./index');

  expect(addListener).toHaveBeenCalledTimes(1);
  const listener = addListener.mock.calls[0]?.[0] as (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean;
  const sendResponse = vi.fn();
  expect(listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, sendResponse)).toBe(true);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'supported', findingCount: 0 }));
  expect(document.querySelectorAll('[data-clearchoice-panel]')).toHaveLength(1);
});

it('preserves host panel markup through Analyze and Restore', async () => {
  const { addListener } = installChrome();
  setSupportedCheckoutContext();
  const hostPanel = document.createElement('aside');
  hostPanel.dataset.clearchoicePanel = '';
  hostPanel.textContent = 'Host checkout sidebar';
  document.body.append(hostPanel);

  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean;
  const analyzeResponse = vi.fn();
  const restoreResponse = vi.fn();

  expect(listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, analyzeResponse)).toBe(true);
  await vi.waitFor(() => expect(analyzeResponse).toHaveBeenCalledWith({ ok: true, status: 'supported', findingCount: 0 }));
  expect(listener({ type: 'CLEARCHOICE_RESTORE' }, {}, restoreResponse)).toBe(true);
  await vi.waitFor(() => expect(restoreResponse).toHaveBeenCalledWith({ ok: true }));

  expect(hostPanel.isConnected).toBe(true);
  expect(hostPanel.textContent).toBe('Host checkout sidebar');
});

it('removes only its own panel and returns a count-only unsupported response without reading private form values', async () => {
  const { addListener } = installChrome();
  setSupportedCheckoutContext();
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean;
  const initialResponse = vi.fn();
  listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, initialResponse);
  await vi.waitFor(() => expect(document.querySelector('[data-clearchoice-panel]')).not.toBeNull());

  document.body.innerHTML = `
    <main><h1>Account settings</h1><p>Manage payment preferences.</p></main>
    <input value="private@example.test" placeholder="Checkout Order summary Pay now" autocomplete="cc-number">
    <textarea>4111111111111111 Checkout Order summary Place order</textarea>
    <select><option>confidential Order total</option></select>
    <div contenteditable="true">secret Checkout Subtotal</div>
  `;
  const sendResponse = vi.fn();

  expect(listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, sendResponse)).toBe(true);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'unsupported-context', findingCount: 0 }));

  const serialized = JSON.stringify({ response: sendResponse.mock.calls[0]?.[0], panel: document.querySelector('[data-clearchoice-panel]')?.textContent });
  expect(serialized).not.toContain('private@example.test');
  expect(serialized).not.toContain('4111111111111111');
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
});

it('ignores malformed inbound requests without analyzing or restoring', async () => {
  const { addListener } = installChrome();
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean | undefined;
  const sendResponse = vi.fn();

  expect(listener({ type: 'CLEARCHOICE_ANALYZE', pageTitle: 'private' }, {}, sendResponse)).toBeUndefined();
  expect(listener({ type: 'CLEARCHOICE_RESTORE', checkoutHtml: '<form>' }, {}, sendResponse)).toBeUndefined();
  await Promise.resolve();

  expect(sendResponse).not.toHaveBeenCalled();
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
});

it('content-payload/JSDOM integration: a sensitive static candidate never reaches a rendered evidence element', async () => {
  const { addListener } = installChrome();
  const maskedCard = 'Card (**** 4242)';
  document.body.innerHTML = `
    <main>
      <aside>Order summary — Subtotal: $24</aside>
      <section>Membership renews automatically every month for $12. ${maskedCard}</section>
      <button>Place order</button>
    </main>`;
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean;
  const sendResponse = vi.fn();

  expect(listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, sendResponse)).toBe(true);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'supported', findingCount: 0 }));

  const panel = document.querySelector<HTMLElement>('[data-clearchoice-panel]');
  const content = panel?.shadowRoot ?? panel;
  expect(content?.querySelectorAll('.evidence')).toHaveLength(0);
  expect(content?.textContent).not.toContain(maskedCard);
});

it.each([
  'Payment xxxx 4242',
  'Payment:xxxx 4242',
  'Payment (xxxx 4242)',
  'Payment method: XXXX 4242',
])('content-payload/JSDOM integration: payment-context x-masked card text never reaches evidence or a rendered evidence element: %s', async (maskedCard) => {
  const { addListener } = installChrome();
  document.body.innerHTML = `
    <main>
      <aside>Order summary — Subtotal: $24</aside>
      <section>Membership renews automatically every month for $12. ${maskedCard}</section>
      <button>Place order</button>
    </main>`;
  await import('./index');
  const listener = addListener.mock.calls[0]?.[0] as (
    message: unknown,
    sender: unknown,
    sendResponse: (response: unknown) => void,
  ) => boolean;
  const sendResponse = vi.fn();

  expect(listener({ type: 'CLEARCHOICE_ANALYZE' }, {}, sendResponse)).toBe(true);
  await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, status: 'supported', findingCount: 0 }));

  const panel = document.querySelector<HTMLElement>('[data-clearchoice-panel]');
  const content = panel?.shadowRoot ?? panel;
  expect(content?.querySelectorAll('.evidence')).toHaveLength(0);
  expect(content?.textContent).not.toContain(maskedCard);
});

it('content-payload/JSDOM integration preserves every host checkout integrity predicate through Analyze, Dismiss, Restore, repeated Analyze, and summary replacement', async () => {
  const { addListener } = installChrome();
  document.body.innerHTML = `
    <main><h1>Local beta checkout</h1>
      <form id="checkout" action="#fake-order-confirmation">
        <input id="email" name="fake-email" type="email" value="beta-customer@example.test">
        <input id="paid" name="fake-protection" type="checkbox" checked>
        <input id="gift" name="fake-gift" type="checkbox">
        <input id="disabled" name="fake-card" type="text" value="fake-card-4242" disabled>
        <select id="delivery" name="fake-delivery"><option value="standard" selected>Standard</option><option value="express">Express</option></select>
        <button id="submit" type="submit">Place fake order</button>
      </form>
      <aside id="order-summary">Order summary — Beta membership renews automatically for $12 per month until cancelled.</aside>
      <button id="replace-summary" type="button">Replace fake order summary</button>
      <a id="fragment" href="#delivery-details">Delivery details</a><section id="delivery-details"></section>
    </main>`;
  history.replaceState(null, '', '#checkout');
  await import('./index');

  const hostSnapshot = () => {
    const owned = (node: Element) => node.closest('[data-clearchoice-panel]') !== null;
    return {
      href: location.href,
      forms: Array.from(document.forms, (form) => ({ action: form.action })),
      controls: Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')).filter((node) => !owned(node)).map((node) => ({
        tag: node.tagName, name: node.name, type: node instanceof HTMLInputElement ? node.type : 'select-one', value: node.value,
        checked: node instanceof HTMLInputElement ? node.checked : undefined, disabled: node.disabled,
      })),
      nodes: Array.from(document.querySelectorAll<HTMLElement>('input, button, a')).filter((node) => !owned(node)),
    };
  };
  const listener = addListener.mock.calls[0]?.[0] as (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;
  const request = async (type: 'CLEARCHOICE_ANALYZE' | 'CLEARCHOICE_RESTORE') => {
    const sendResponse = vi.fn();
    expect(listener({ type }, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  };
  const assertUnchanged = () => {
    const after = hostSnapshot();
    expect(after.href).toBe(before.href);
    expect(after.forms).toEqual(before.forms);
    expect(after.controls).toEqual(before.controls);
    expect(after.nodes).toEqual(before.nodes);
  };

  const received: string[] = [];
  for (const eventName of ['pointerdown', 'pointerup', 'keydown', 'submit', 'click']) {
    document.addEventListener(eventName, () => received.push(eventName));
  }
  expect(document.querySelector<HTMLInputElement>('#email')?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'A' }))).toBe(true);
  expect(document.querySelector('#paid')?.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))).toBe(true);
  expect(document.querySelector('#paid')?.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }))).toBe(true);
  expect(document.querySelector('#checkout')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))).toBe(true);
  expect(document.querySelector('#fragment')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true);
  expect(received).toEqual(expect.arrayContaining(['keydown', 'pointerdown', 'pointerup', 'submit', 'click']));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = hostSnapshot();

  await request('CLEARCHOICE_ANALYZE');
  expect(document.querySelectorAll('[data-clearchoice-panel]')).toHaveLength(1);
  expect(document.querySelector('[data-clearchoice-panel]')?.closest('form')).toBeNull();
  assertUnchanged();

  const panel = document.querySelector<HTMLElement>('[data-clearchoice-panel]');
  const dismiss = panel?.shadowRoot?.querySelector<HTMLButtonElement>('button') ?? panel?.querySelector<HTMLButtonElement>('button');
  dismiss?.click();
  expect(document.querySelectorAll('[data-clearchoice-panel]')).toHaveLength(0);
  assertUnchanged();

  await request('CLEARCHOICE_RESTORE');
  expect(document.querySelectorAll('[data-clearchoice-panel]')).toHaveLength(0);
  assertUnchanged();

  await request('CLEARCHOICE_ANALYZE');
  await request('CLEARCHOICE_ANALYZE');
  expect(document.querySelectorAll('[data-clearchoice-panel]')).toHaveLength(1);
  assertUnchanged();

  const summary = document.querySelector('#order-summary');
  const replacement = document.createElement('aside');
  replacement.id = 'order-summary';
  replacement.textContent = 'Updated local order summary';
  summary?.replaceWith(replacement);
  await Promise.resolve();
  expect(document.querySelectorAll('[data-clearchoice-panel]')).toHaveLength(1);
  assertUnchanged();
});
