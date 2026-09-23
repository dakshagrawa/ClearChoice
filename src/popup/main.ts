import type { AnalyzeResponse } from '../shared/messages';
import { analyzeActiveTab, restoreActiveTab } from '../shared/tab-analysis';

const app = document.querySelector<HTMLElement>('#app');

if (!app) throw new Error('ClearChoice popup root is missing.');

app.innerHTML = `
  <main>
    <h1>ClearChoice</h1>
    <p>Review the active page for possible recurring charges and preselected paid options.</p>
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

function findingStatus(count: number): string {
  if (count === 0) return 'No findings shown on this page.';
  if (count === 1) return '1 finding shown on this page.';
  return `${count} findings shown on this page.`;
}

function analysisStatus(response: AnalyzeResponse): string {
  if (!response.ok) {
    if (response.error === 'restricted-page') return 'ClearChoice cannot run on this browser page.';
    if (response.error === 'injection-failed') return 'ClearChoice could not start on this page. Reload and try again.';
    return 'ClearChoice could not analyze this page. Reload and try again.';
  }
  if (response.status === 'unsupported-context') return 'This page does not look like a supported checkout context.';
  return findingStatus(response.findingCount);
}

analyzeButton.addEventListener('click', async () => {
  analyzeButton.disabled = true;
  status.textContent = 'Analyzing this page…';

  try {
    status.textContent = analysisStatus(await analyzeActiveTab());
  } finally {
    analyzeButton.disabled = false;
  }
});

restoreButton.addEventListener('click', async () => {
  restoreButton.disabled = true;
  status.textContent = 'Restoring dismissed findings…';

  try {
    const response = await restoreActiveTab();
    status.textContent = response.ok
      ? 'Dismissal restored. Analyze again to show findings.'
      : 'ClearChoice could not restore dismissed findings. Reload and try again.';
  } finally {
    restoreButton.disabled = false;
  }
});
