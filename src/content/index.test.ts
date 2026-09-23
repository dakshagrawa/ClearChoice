import { afterEach, expect, it, vi } from 'vitest';

function installChrome(): { addListener: ReturnType<typeof vi.fn> } {
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener } },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ dismissed: false }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
  return { addListener };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.querySelector('[data-clearchoice-panel]')?.remove();
  delete (window as Window & { __clearchoiceContentListenerInstalled__?: true }).__clearchoiceContentListenerInstalled__;
});

function setSupportedCheckoutContext(): void {
  document.body.innerHTML = '<main><aside>Order summary — Subtotal: $24</aside><button>Place order</button></main>';
}

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
