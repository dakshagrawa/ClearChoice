import { isAnalyzeResponse, CLEARCHOICE_ANALYZE } from '../shared/messages';

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
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const orderedTabs = [...tabs.filter((candidate) => candidate.active), ...tabs.filter((candidate) => !candidate.active)];
    let response: unknown;
    let delivered = false;
    for (const tab of orderedTabs) {
      if (tab.id === undefined) continue;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { type: CLEARCHOICE_ANALYZE });
        delivered = true;
        break;
      } catch {
        // A tab without the local content script is not an analysis target.
      }
    }
    if (!delivered) throw new Error('No local checkout tab is available.');

    if (!isAnalyzeResponse(response)) {
      status.textContent = 'ClearChoice received an invalid analysis response. Reload the page and try again.';
      return;
    }
    if (!response.ok) {
      status.textContent = response.error;
      return;
    }
    status.textContent = response.result.findings.length === 1
      ? '1 finding shown on this page.'
      : `${response.result.findings.length} findings shown on this page.`;
  } catch {
    status.textContent = 'ClearChoice is available only on the local mock checkout page. Reload that page and try again.';
  } finally {
    analyzeButton.disabled = false;
  }
});
