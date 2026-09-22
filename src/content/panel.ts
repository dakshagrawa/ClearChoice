import type { AnalysisResult, FindingReason } from '../core/types';
import panelCss from './panel.css?inline';

const panelSelector = 'aside[data-clearchoice-panel]';
const panelCleanup = new WeakMap<HTMLElement, () => void>();

const reasonText: Record<FindingReason, string> = {
  'price-cadence': 'It includes a price together with a repeating billing cadence.',
  'renewal-language': 'It uses language about automatic renewal or recurring billing.',
  'subscription-language': 'It mentions a subscription, so confirm whether any charge repeats.',
  'checked-paid-control': 'It was already selected and describes a paid option.',
};

function contentRoot(panel: HTMLElement): ShadowRoot | HTMLElement {
  if (typeof panel.attachShadow === 'function') return panel.attachShadow({ mode: 'open' });
  return panel;
}

export function removePanel(): void {
  const panel = document.querySelector<HTMLElement>(panelSelector);
  if (!panel) return;
  panelCleanup.get(panel)?.();
  panel.remove();
}

export function renderPanel(result: AnalysisResult, onDismiss: () => void): HTMLElement {
  removePanel();

  const panel = document.createElement('aside');
  panel.dataset.clearchoicePanel = '';
  panel.setAttribute('aria-live', 'polite');
  panel.setAttribute('aria-label', 'ClearChoice findings');

  const root = contentRoot(panel);
  const style = document.createElement('style');
  style.textContent = panelCss;
  root.append(style);

  const container = document.createElement('section');
  container.className = 'clearchoice-panel';
  container.innerHTML = '<div class="clearchoice-header"><h2>ClearChoice findings</h2></div>';

  let dismissed = false;
  const dismissPanel = () => {
    if (dismissed || !panel.isConnected) return;
    dismissed = true;
    cleanup();
    panel.remove();
    onDismiss();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key.localeCompare('Escape') === 0 || event.code === 'Escape') dismissPanel();
  };
  const cleanup = () => {
    document.removeEventListener('keydown', onKeydown);
    panelCleanup.delete(panel);
  };

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.dataset.clearchoiceDismiss = '';
  dismiss.setAttribute('aria-label', 'Dismiss ClearChoice findings');
  dismiss.addEventListener('click', dismissPanel);
  container.querySelector('.clearchoice-header')?.append(dismiss);

  for (const finding of result.findings) {
    const findingElement = document.createElement('article');
    const title = document.createElement('h3');
    title.textContent = finding.title;
    const explanation = document.createElement('p');
    explanation.textContent = finding.explanation;
    const evidence = document.createElement('p');
    evidence.className = 'evidence';
    evidence.textContent = finding.evidence;
    const reasonHeading = document.createElement('h4');
    reasonHeading.textContent = 'Why this was flagged';
    const reason = document.createElement('p');
    reason.className = 'reason';
    reason.textContent = reasonText[finding.reason];
    findingElement.append(title, explanation, evidence, reasonHeading, reason);
    container.append(findingElement);
  }

  root.append(container);
  document.documentElement.append(panel);
  document.addEventListener('keydown', onKeydown);
  panelCleanup.set(panel, cleanup);
  return panel;
}
