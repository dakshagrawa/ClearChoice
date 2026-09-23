import { afterEach, expect, it, vi } from 'vitest';

function installChrome(response: unknown): { query: ReturnType<typeof vi.fn>; executeScript: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue([{ id: 42, active: true }]);
  const executeScript = vi.fn().mockResolvedValue([]);
  const sendMessage = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('chrome', { tabs: { query, sendMessage }, scripting: { executeScript } });
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

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('shows only the safe successful finding count', async () => {
  const app = await renderPopup({ ok: true, status: 'supported', findingCount: 1 });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('1 finding shown on this page.');
});

it('uses the non-claiming unsupported context status', async () => {
  const app = await renderPopup({ ok: true, status: 'unsupported-context', findingCount: 0 });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('This page does not look like a supported checkout context.');
});

it('shows typed adapter errors without exposing page data', async () => {
  const app = await renderPopup({ ok: false, error: 'restricted-page' });
  expect(app.querySelector('[role="status"]')?.textContent).toBe('ClearChoice cannot run on this browser page.');
});

it('uses active current-tab injection for Restore without analyzing again', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const { query, executeScript, sendMessage } = installChrome({ ok: true });
  await import('./main');

  document.querySelector<HTMLButtonElement>('button:last-of-type')?.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('button:last-of-type')?.disabled).toBe(false));

  expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ['content.js'] });
  expect(sendMessage).toHaveBeenCalledWith(42, { type: 'CLEARCHOICE_RESTORE' });
});
