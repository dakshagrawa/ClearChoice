import { afterEach, expect, it, vi } from 'vitest';

import { renderPanel } from './panel';
import type { AnalysisResult } from '../core/types';

const result: AnalysisResult = {
  findings: [
    {
      id: 'finding-1',
      kind: 'preselected-addon',
      reason: 'checked-paid-control',
      severity: 'notice',
      title: 'Preselected paid option',
      explanation: 'This option is already selected and may add a cost. Review it before continuing.',
      evidence: 'Add protection for $5',
      selector: 'label:nth-of-type(1)',
    },
  ],
  analyzedAt: '2026-09-22T00:00:00.000Z',
  pageTitle: 'Mock checkout',
};

afterEach(() => {
  document.querySelector('[data-clearchoice-panel]')?.remove();
});

it('renders an accessible non-modal panel with auditable finding evidence and reason', () => {
  renderPanel(result, vi.fn());

  const panel = document.querySelector<HTMLElement>('aside[data-clearchoice-panel]');
  expect(panel).not.toBeNull();
  expect(panel?.getAttribute('role')).not.toBe('dialog');
  expect(panel?.getAttribute('aria-live')).toBe('polite');
  const content = panel?.shadowRoot ?? panel;
  expect(content?.textContent).toContain('Preselected paid option');
  expect(content?.textContent).toContain('This option is already selected and may add a cost. Review it before continuing.');
  expect(content?.textContent).toContain('Add protection for $5');
  expect(content?.textContent).toContain('Why this was flagged');
  expect(content?.textContent).toContain('It was already selected and describes a paid option.');

  const dismiss = panel?.shadowRoot?.querySelector<HTMLButtonElement>('button') ?? panel?.querySelector('button');
  expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss ClearChoice findings');
  expect(dismiss?.getAttribute('data-clearchoice-dismiss')).toBe('');
});

it('removes the panel through its dismiss button without touching checkout controls', () => {
  const onDismiss = vi.fn();
  const control = document.createElement('input');
  control.type = 'checkbox';
  control.checked = true;
  document.body.append(control);

  renderPanel(result, onDismiss);
  const panel = document.querySelector<HTMLElement>('aside[data-clearchoice-panel]');
  const dismiss = panel?.shadowRoot?.querySelector<HTMLButtonElement>('button') ?? panel?.querySelector('button');
  dismiss?.click();

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
  expect(control.checked).toBe(true);
  control.remove();
});

it('dismisses only its own panel when Escape is pressed', () => {
  const onDismiss = vi.fn();
  const unrelated = document.createElement('aside');
  unrelated.dataset.unrelatedPanel = '';
  document.body.append(unrelated);

  renderPanel(result, onDismiss);
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
  expect(document.querySelector('[data-unrelated-panel]')).toBe(unrelated);
  unrelated.remove();
});
