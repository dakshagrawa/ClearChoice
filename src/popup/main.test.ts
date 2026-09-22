import { afterEach, expect, it, vi } from 'vitest';

const result = {
  findings: [
    {
      id: 'finding-1',
      kind: 'recurring-charge' as const,
      reason: 'price-cadence' as const,
      severity: 'notice' as const,
      title: 'Possible recurring charge',
      explanation: 'Check the schedule.',
      evidence: '$12 per month',
      selector: 'section',
    },
  ],
  analyzedAt: '2026-09-22T00:00:00.000Z',
  pageTitle: 'Mock checkout',
};

async function renderPopup(response: unknown): Promise<HTMLElement> {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 42, active: true }]),
      sendMessage: vi.fn().mockResolvedValue(response),
    },
  });

  await import('./main');
  const button = document.querySelector<HTMLButtonElement>('button');
  button?.click();
  await vi.waitFor(() => expect(button?.disabled).toBe(false));
  return document.querySelector<HTMLElement>('#app')!;
}

async function renderUnsupportedPopup(): Promise<HTMLElement> {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn().mockResolvedValue([]), sendMessage: vi.fn() },
  });
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

it('shows the number of findings from a valid successful analysis response', async () => {
  const app = await renderPopup({ ok: true, result });

  expect(app.querySelector('[role="status"]')?.textContent).toBe('1 finding shown on this page.');
});

it('uses clear zero and plural finding status messages', async () => {
  const zero = await renderPopup({ ok: true, result: { ...result, findings: [] } });
  expect(zero.querySelector('[role="status"]')?.textContent).toBe('No findings shown on this page.');

  const plural = await renderPopup({ ok: true, result: { ...result, findings: [result.findings[0], result.findings[0]] } });
  expect(plural.querySelector('[role="status"]')?.textContent).toBe('2 findings shown on this page.');
});

it('shows a clean unsupported-page status when no tab accepts analysis', async () => {
  const app = await renderUnsupportedPopup();

  expect(app.querySelector('[role="status"]')?.textContent).toBe('ClearChoice is available only on the local mock checkout page. Reload that page and try again.');
});

it('offers Restore and sends the typed restore message without analyzing again', async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  const sendMessage = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42, active: true }]), sendMessage },
  });
  await import('./main');

  document.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false));
  document.querySelector<HTMLButtonElement>('button:last-of-type')?.click();

  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(42, { type: 'CLEARCHOICE_RESTORE' }));
});

it('shows a human-readable analysis error response', async () => {
  const app = await renderPopup({ ok: false, error: 'The checkout could not be analyzed.' });

  expect(app.querySelector('[role="status"]')?.textContent).toBe('The checkout could not be analyzed.');
});

it('rejects a malformed runtime analysis response without reading findings', async () => {
  const app = await renderPopup({ ok: true, result: { findings: 'not an array' } });

  expect(app.querySelector('[role="status"]')?.textContent).toBe('ClearChoice received an invalid analysis response. Reload the page and try again.');
});
