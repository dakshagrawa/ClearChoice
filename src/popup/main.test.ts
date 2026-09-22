import { afterEach, expect, it, vi } from 'vitest';

const result = {
  findings: [
    {
      id: 'finding-1',
      kind: 'recurring-charge',
      severity: 'notice',
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
      query: vi.fn().mockResolvedValue([{ id: 42 }]),
      sendMessage: vi.fn().mockResolvedValue(response),
    },
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

it('shows a human-readable analysis error response', async () => {
  const app = await renderPopup({ ok: false, error: 'The checkout could not be analyzed.' });

  expect(app.querySelector('[role="status"]')?.textContent).toBe('The checkout could not be analyzed.');
});

it('rejects a malformed runtime analysis response without reading findings', async () => {
  const app = await renderPopup({ ok: true, result: { findings: 'not an array' } });

  expect(app.querySelector('[role="status"]')?.textContent).toBe('ClearChoice received an invalid analysis response. Reload the page and try again.');
});
