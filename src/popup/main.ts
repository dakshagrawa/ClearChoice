import {
  CLEARCHOICE_ANALYZE,
  CLEARCHOICE_RESTORE,
  isAnalyzeResponse,
  isRestoreResponse,
} from '../shared/messages';

const app = document.querySelector<HTMLElement>('#app');

if (!app) throw new Error('ClearChoice popup root is missing.');

app.innerHTML = `
  <main>
    <h1>ClearChoice</h1>
    <p>Analyze this local mock checkout for potential recurring charges and preselected paid options.</p>
    <div class="actions">
      <button type="button" data-action="analyze">Analyze</button>
      <button type="button" data-action="restore">Restore</button>
    </div>
    <p aria-live="polite" role="status"></p>
  </main>
`;

const analyzeButton = app.querySelector<HTMLButtonElement>('[data-action="analyze"]');
const restoreButton = app.querySelector<HTMLButtonElement>('[data-action="restore"]');
const status = app.querySelector<HTMLParagraphElement>('[role="status"]');

if (!analyzeButton || !restoreButton || !status) throw new Error('ClearChoice popup controls are missing.');

async function sendToSupportedTab(message: { type: typeof CLEARCHOICE_ANALYZE | typeof CLEARCHOICE_RESTORE }): Promise<unknown> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const orderedTabs = [...tabs.filter((candidate) => candidate.active), ...tabs.filter((candidate) => !candidate.active)];
  for (const tab of orderedTabs) {
    if (tab.id === undefined) continue;
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // A tab without the local content script is not an analysis target.
    }
  }
  throw new Error('No local checkout tab is available.');
}

function findingStatus(count: number): string {
  if (count === 0) return 'No findings shown on this page.';
  if (count === 1) return '1 finding shown on this page.';
  return `${count} findings shown on this page.`;
}

analyzeButton.addEventListener('click', async () => {
  analyzeButton.disabled = true;
  status.textContent = 'Analyzing this page…';

  try {
    const response = await sendToSupportedTab({ type: CLEARCHOICE_ANALYZE });
    if (!isAnalyzeResponse(response)) {
      status.textContent = 'ClearChoice received an invalid analysis response. Reload the page and try again.';
      return;
    }
    if (!response.ok) {
      status.textContent = response.error;
      return;
    }
    status.textContent = findingStatus(response.result.findings.length);
  } catch {
    status.textContent = 'ClearChoice is available only on the local mock checkout page. Reload that page and try again.';
  } finally {
    analyzeButton.disabled = false;
  }
});

restoreButton.addEventListener('click', async () => {
  restoreButton.disabled = true;
  status.textContent = 'Restoring dismissed findings…';

  try {
    const response = await sendToSupportedTab({ type: CLEARCHOICE_RESTORE });
    if (!isRestoreResponse(response)) {
      status.textContent = 'ClearChoice received an invalid restore response. Reload the page and try again.';
      return;
    }
    status.textContent = response.ok ? 'Dismissal restored. Analyze again to show findings.' : response.error;
  } catch {
    status.textContent = 'ClearChoice is available only on the local mock checkout page. Reload that page and try again.';
  } finally {
    restoreButton.disabled = false;
  }
});
