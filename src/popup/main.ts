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
    <p aria-live="polite" role="status">Analyze this tab locally.</p>
  </main>
`;

const analyzeButton = app.querySelector<HTMLButtonElement>('[data-action="analyze"]');
const restoreButton = app.querySelector<HTMLButtonElement>('[data-action="restore"]');
const status = app.querySelector<HTMLParagraphElement>('[role="status"]');

if (!analyzeButton || !restoreButton || !status) throw new Error('ClearChoice popup controls are missing.');

function findingStatus(count: number): string {
  if (count === 0) return 'No matching signals found on this page.';
  if (count === 1) return '1 possible signal found.';
  return `${count} possible signals found.`;
}

function analysisStatus(response: AnalyzeResponse): string {
  if (!response.ok) {
    if (response.error === 'restricted-page') return 'Chrome does not allow ClearChoice to analyze this page.';
    if (response.error === 'injection-failed') return 'ClearChoice could not analyze this tab. Reload it and try again.';
    return 'ClearChoice could not analyze this page. Reload and try again.';
  }
  if (response.status === 'unsupported-context') return 'This page does not look like a supported English checkout page.';
  return findingStatus(response.findingCount);
}

analyzeButton.addEventListener('click', async () => {
  analyzeButton.disabled = true;
  status.textContent = 'Analyzing this tab locally…';

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
