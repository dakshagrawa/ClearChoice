import { CLEARCHOICE_ANALYZE } from '../shared/messages';
import type { AnalyzeResponse } from '../shared/messages';

const app = document.querySelector<HTMLElement>('#app');

if (!app) {
  throw new Error('ClearChoice popup root is missing.');
}

app.innerHTML = `
  <main>
    <h1>ClearChoice</h1>
    <p>Analyze this local mock checkout for potential recurring charges and preselected paid options.</p>
    <button type="button">Analyze</button>
    <p aria-live="polite" role="status"></p>
  </main>
`;

const analyzeButton = app.querySelector<HTMLButtonElement>('button');
const status = app.querySelector<HTMLParagraphElement>('[role="status"]');

if (!analyzeButton || !status) {
  throw new Error('ClearChoice popup controls are missing.');
}

analyzeButton.addEventListener('click', async () => {
  analyzeButton.disabled = true;
  status.textContent = 'Analyzing this page…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('No active tab is available.');

    const response = await chrome.tabs.sendMessage(tab.id, { type: CLEARCHOICE_ANALYZE }) as AnalyzeResponse;
    status.textContent = response.findings.length === 1
      ? '1 finding shown on this page.'
      : `${response.findings.length} findings shown on this page.`;
  } catch {
    status.textContent = 'ClearChoice is available only on the local mock checkout page. Reload that page and try again.';
  } finally {
    analyzeButton.disabled = false;
  }
});
