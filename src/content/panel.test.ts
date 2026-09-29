import { afterEach, expect, it, vi } from 'vitest';

import { isOwnedPanelMutation, removePanel, renderAutomaticDiagnostic, renderPanel } from './panel';
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
};

afterEach(() => {
  removePanel();
  document.body.replaceChildren();
});

it('diagnostic states no partial finding was saved and does not render articles', () => {
  const panel = renderAutomaticDiagnostic(vi.fn());
  expect(panel.shadowRoot?.textContent).toContain('could not be saved');
  expect(panel.shadowRoot?.querySelectorAll('article')).toHaveLength(0);
});

it('distinguishes owned mutations from host panels with a colliding attribute', async () => {
  const host = document.createElement('aside');
  host.dataset.clearchoicePanel = '';
  document.body.append(host);
  const owned = renderPanel(result, vi.fn());
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((changes) => records.push(...changes));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  owned.append(document.createElement('span'));
  host.append(document.createElement('span'));
  await Promise.resolve();
  observer.disconnect();
  expect(records).toHaveLength(2);
  expect(isOwnedPanelMutation(records[0])).toBe(true);
  expect(isOwnedPanelMutation(records[1])).toBe(false);
});

it('payload-level accessibility: renders a semantic non-modal polite panel with auditable finding evidence and reason', () => {
  renderPanel(result, vi.fn());

  const panel = document.querySelector<HTMLElement>('aside[data-clearchoice-panel]');
  expect(panel).not.toBeNull();
  expect(panel?.getAttribute('role')).not.toBe('dialog');
  expect(panel?.getAttribute('aria-modal')).toBeNull();
  expect(panel?.getAttribute('aria-live')).toBe('polite');
  expect(panel?.getAttribute('aria-label')).toBe('ClearChoice findings');
  const content = panel?.shadowRoot ?? panel;
  expect(content?.textContent).toContain('Preselected paid option');
  expect(content?.textContent).toContain('This option is already selected and may add a cost. Review it before continuing.');
  expect(content?.textContent).toContain('Add protection for $5');
  expect(content?.textContent).toContain('Why this was flagged');
  expect(content?.textContent).toContain('It was already selected and describes a paid option.');

  const dismiss = panel?.shadowRoot?.querySelector<HTMLButtonElement>('button') ?? panel?.querySelector('button');
  expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss ClearChoice findings');
  expect(dismiss?.getAttribute('data-clearchoice-dismiss')).toBe('');
  expect(content?.querySelector('h2')?.textContent).toBe('ClearChoice findings');
});

it.each(['light', 'dark'])('payload-level accessibility: supports keyboard dismissal and focus styling in a %s fixture context', (colorScheme) => {
  document.documentElement.style.colorScheme = colorScheme;
  renderPanel(result, vi.fn());

  const panel = document.querySelector<HTMLElement>('aside[data-clearchoice-panel]');
  const dismiss = panel?.shadowRoot?.querySelector<HTMLButtonElement>('button') ?? panel?.querySelector('button');
  dismiss?.focus();

  expect(document.activeElement === dismiss || panel?.shadowRoot?.activeElement === dismiss).toBe(true);
  expect(dismiss?.getBoundingClientRect().width || 44).toBeGreaterThanOrEqual(44);
  expect(dismiss?.getBoundingClientRect().height || 44).toBeGreaterThanOrEqual(44);
  dismiss?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(panel?.shadowRoot?.querySelector('[data-clearchoice-dismiss]')).toBe(dismiss);
  document.documentElement.style.colorScheme = '';
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
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-clearchoice-panel]')).toBeNull();
  expect(document.querySelector('[data-unrelated-panel]')).toBe(unrelated);
  unrelated.remove();
});

it('preserves host panel markup that uses the extension data attribute', () => {
  const hostPanel = document.createElement('aside');
  hostPanel.dataset.clearchoicePanel = '';
  hostPanel.textContent = 'Host checkout sidebar';
  document.body.append(hostPanel);

  const extensionPanel = renderPanel(result, vi.fn());
  removePanel();

  expect(hostPanel.isConnected).toBe(true);
  expect(hostPanel.textContent).toBe('Host checkout sidebar');
  expect(extensionPanel.isConnected).toBe(false);
});

it('re-renders by removing only the prior extension-owned panel', () => {
  const hostPanel = document.createElement('aside');
  hostPanel.dataset.clearchoicePanel = '';
  hostPanel.textContent = 'Host checkout sidebar';
  document.body.append(hostPanel);

  const firstExtensionPanel = renderPanel(result, vi.fn());
  const secondExtensionPanel = renderPanel(result, vi.fn());

  expect(hostPanel.isConnected).toBe(true);
  expect(hostPanel.textContent).toBe('Host checkout sidebar');
  expect(firstExtensionPanel.isConnected).toBe(false);
  expect(secondExtensionPanel.isConnected).toBe(true);
});

it('cleans ownership and Escape handling when the host removes its panel, then re-renders', async () => {
  const onDismiss = vi.fn();
  const firstPanel = renderPanel(result, onDismiss);
  firstPanel.remove();
  await Promise.resolve();

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(onDismiss).not.toHaveBeenCalled();

  const secondPanel = renderPanel(result, onDismiss);
  expect(secondPanel.isConnected).toBe(true);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it('observes only direct removal of its owned panel for lifecycle cleanup', () => {
  const originalMutationObserver = globalThis.MutationObserver;
  const observe = vi.fn();
  class PanelRemovalObserver {
    constructor(_callback: MutationCallback) { void _callback; }
    disconnect = vi.fn();
    observe = observe;
    takeRecords = vi.fn(() => []);
  }
  vi.stubGlobal('MutationObserver', PanelRemovalObserver);

  try {
    renderPanel(result, vi.fn());
    expect(observe).toHaveBeenCalledWith(document.documentElement, { childList: true });
  } finally {
    removePanel();
    vi.stubGlobal('MutationObserver', originalMutationObserver);
  }
});
