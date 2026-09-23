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
  document.querySelector('[data-clearchoice-panel]')?.remove();
  delete (window as Window & { __clearchoiceContentListenerInstalled__?: true }).__clearchoiceContentListenerInstalled__;
});

it('registers one listener and renders one panel when the payload is injected repeatedly', async () => {
  const { addListener } = installChrome();

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
