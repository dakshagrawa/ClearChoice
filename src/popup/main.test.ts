import { afterEach, expect, it, vi } from 'vitest';

function installChrome(response: unknown): { query: ReturnType<typeof vi.fn>; executeScript: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue([{ id: 42, active: true }]);
  const executeScript = vi.fn().mockResolvedValue([]);
  const sendMessage = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('chrome', { tabs: { query, sendMessage: vi.fn() }, scripting: { executeScript }, runtime: { sendMessage } });
  return { query, executeScript, sendMessage };
}

async function renderPopup(response: unknown): Promise<HTMLElement> {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  installChrome(response);
  await import('./main');
  const button = document.querySelector<HTMLButtonElement>('button');
  button?.click();
  await vi.waitFor(() => expect(button?.disabled).toBe(false));
  return document.querySelector<HTMLElement>('#app')!;
}

async function renderPopupBeforeResponse(): Promise<{ app: HTMLElement; resolve: (response: unknown) => void }> {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  let resolveResponse!: (response: unknown) => void;
  installChrome(new Promise((resolve) => { resolveResponse = resolve; }));
  await import('./main');
  document.querySelector<HTMLButtonElement>('button')?.click();
  return { app: document.querySelector<HTMLElement>('#app')!, resolve: resolveResponse };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('uses the exact local-only initial, working, and singular successful statuses', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  installChrome({ ok: true, status: 'supported', findingCount: 1 });
  await import('./main');
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Analyze this tab locally.');

  const pending = await renderPopupBeforeResponse();
  expect(pending.app.querySelector('[role="status"]')?.textContent).toBe('Analyzing this tab locally…');
  pending.resolve({ ok: true, status: 'supported', findingCount: 1 });
  await vi.waitFor(() => expect(pending.app.querySelector('[role="status"]')?.textContent).toBe('1 possible signal found.'));
});

it('uses the exact zero and plural successful finding statuses', async () => {
  const zero = await renderPopup({ ok: true, status: 'supported', findingCount: 0 });
  expect(zero.querySelector('[role="status"]')?.textContent).toBe('No matching signals found on this page.');

  const plural = await renderPopup({ ok: true, status: 'supported', findingCount: 2 });
  expect(plural.querySelector('[role="status"]')?.textContent).toBe('2 possible signals found.');
});

it('uses the exact unsupported context status', async () => {
  const app = await renderPopup({ ok: true, status: 'unsupported-context', findingCount: 0 });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('This page does not look like a supported English checkout page.');
});

it('uses the exact restricted-page status', async () => {
  const app = await renderPopup({ ok: false, error: 'restricted-page' });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('Chrome does not allow ClearChoice to analyze this page.');
});

it('uses the exact generic injection failure status', async () => {
  const app = await renderPopup({ ok: false, error: 'injection-failed' });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('ClearChoice could not analyze this tab. Reload it and try again.');
});

it('uses active current-tab injection for Restore without analyzing again', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const { query, executeScript, sendMessage } = installChrome({ ok: true });
  await import('./main');

  document.querySelector<HTMLButtonElement>('button:last-of-type')?.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('button:last-of-type')?.disabled).toBe(false));

  expect(query).not.toHaveBeenCalled();
  expect(executeScript).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith({ type: 'CLEARCHOICE_RESTORE' });
});
