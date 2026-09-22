import panelCss from './panel.css?inline';
import type { AnalysisResult } from '../core/types';

const panelSelector = 'aside[data-clearchoice-panel]';

function contentRoot(panel: HTMLElement): ShadowRoot | HTMLElement {
  if (typeof panel.attachShadow === 'function') {
    return panel.attachShadow({ mode: 'open' });
  }
  return panel;
}

export function removePanel(): void {
  document.querySelector(panelSelector)?.remove();
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

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss ClearChoice findings');
  dismiss.addEventListener('click', () => {
    removePanel();
    onDismiss();
  });
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
    findingElement.append(title, explanation, evidence);
    container.append(findingElement);
  }

  root.append(container);
  document.documentElement.append(panel);
  return panel;
}
