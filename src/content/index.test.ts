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

it('preserves every host checkout state through Analyze, Dismiss, Restore, repeat Analyze, and summary replacement', async () => {
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
