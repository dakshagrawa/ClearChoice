import { mountReview } from './review';
import { mountSubscriptions } from './subscriptions';
import type { AnalyzeResponse, SiteResponse } from '../shared/messages';
import { CLEARCHOICE_ANALYZE, CLEARCHOICE_RESTORE, CLEARCHOICE_SITE_STATUS, CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION, CLEARCHOICE_SITE_REVOKE, isAnalyzeResponse, isRestoreResponse, isSiteResponse } from '../shared/messages';
import { isGrantOrigin } from '../shared/storage';

const app = document.querySelector<HTMLElement>('#app');

if (!app) throw new Error('ClearChoice popup root is missing.');

app.innerHTML = `
  <main>
    <header class="popup-header">
    <h1>ClearChoice</h1>
    <p>Review the active page for possible recurring charges and preselected paid options.</p>
    </header>
    <div class="actions">
      <button type="button" data-action="analyze">Analyze</button>
      <button type="button" data-action="restore">Restore dismissed findings</button>
    </div>
    <p data-analysis-status aria-live="polite" role="status">Analyze this tab locally.</p>
    <section class="site-detection" aria-label="Site detection">
      <h2>Site detection</h2>
      <p data-site-origin></p>
      <p data-site-status role="status" aria-live="polite">Checking this site…</p>
      <div class="site-actions">
      <button type="button" data-action="site-enable" aria-label="Enable detection for this site" disabled>Enable</button>
      <button type="button" data-action="site-disable" aria-label="Disable detection for this site" disabled>Disable</button>
      <details>
        <summary>About site detection</summary>
      <p>Optional detection on supported English checkout pages only. Observations stay local; panels appear only after findings are saved. Enabling a site does not confirm a completed scan.</p>
      </details>
      </div>
    </section>
  </main>
`;

const reviewRoot = document.createElement('div');
const subscriptionsRoot = document.createElement('div');
app.querySelector('main')!.append(subscriptionsRoot, reviewRoot);
const subscriptions = mountSubscriptions(subscriptionsRoot);
const review = mountReview(reviewRoot, (item, control) => subscriptions.reviewAsSubscription(item, control), subscriptions.invalidateSuggestion);

const analyzeButton = app.querySelector<HTMLButtonElement>('[data-action="analyze"]');
const restoreButton = app.querySelector<HTMLButtonElement>('[data-action="restore"]');
const status = app.querySelector<HTMLParagraphElement>('[data-analysis-status]');

if (!analyzeButton || !restoreButton || !status) throw new Error('ClearChoice popup controls are missing.');

const enableButton = app.querySelector<HTMLButtonElement>('[data-action="site-enable"]')!;
const disableButton = app.querySelector<HTMLButtonElement>('[data-action="site-disable"]')!;
const siteStatus = app.querySelector<HTMLParagraphElement>('[data-site-status]')!;
let site: { id: number; origin: string } | undefined;
let busy = false;
let analysisPending = false;
let revision = 0;
let enabled = false;
let permitted = false;
let workerUnavailable = false;

function originOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try { const origin = new URL(url).origin; return isGrantOrigin(origin) ? origin : undefined; }
  catch { return undefined; }
}
async function activeSite(): Promise<{ id: number; origin: string } | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return undefined;
  const origin = originOf((await chrome.tabs.get(tab.id)).url);
  return origin ? { id: tab.id, origin } : undefined;
}
async function sameSite(target: { id: number; origin: string }): Promise<boolean> {
  const current = await activeSite();
  return current?.id === target.id && current.origin === target.origin;
}
async function siteMessage(type: string, origin: string): Promise<SiteResponse> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type, origin });
    return isSiteResponse(response) ? response : { ok: false, error: 'request-failed' };
  } catch { return { ok: false, error: 'request-failed' }; }
}
function controls(): void {
  app!.querySelector('.site-detection')!.setAttribute('aria-busy', String(busy));
  restoreButton!.disabled = busy || analysisPending;
  enableButton.disabled = busy || !site || workerUnavailable || enabled;
  disableButton.disabled = busy || !site || (!enabled && !permitted);
}
function invalidateSite(): void {
  site = undefined;
  revision++;
  controls();
  siteStatus.textContent = 'Active tab changed. Reopen the popup for the new site.';
}
chrome.tabs.onActivated?.addListener(({ tabId }) => { if (site && tabId !== site.id) invalidateSite(); });
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (site?.id === tabId && (change.url !== undefined || change.status === 'loading')) invalidateSite();
});
chrome.tabs.onRemoved?.addListener((tabId) => { if (site?.id === tabId) invalidateSite(); });
void (async () => {
  try {
    const target = await activeSite();
    if (busy || revision !== 0) return;
    site = target;
    app.querySelector('[data-site-origin]')!.textContent = target?.origin ?? '';
    if (!target) { siteStatus.textContent = 'Site detection is available only on an HTTPS site.'; return; }
    const response = await siteMessage(CLEARCHOICE_SITE_STATUS, target.origin);
    if (busy || revision !== 0) return;
    if (!await sameSite(target)) { site = undefined; siteStatus.textContent = 'Active tab changed. Reopen the popup for the new site.'; return; }
    if (busy || revision !== 0) return;
    if (!response.ok) {
      workerUnavailable = true;
      try { permitted = await chrome.permissions.contains({ origins: [`${target.origin}/*`] }); }
      catch { permitted = false; }
      if (revision !== 0 || !await sameSite(target)) { invalidateSite(); return; }
      controls();
      siteStatus.textContent = response.error === 'revocation-unsafe'
        ? `Detection state is unsafe for ${target.origin}. Remove site access in Chrome settings before restarting the browser.`
        : permitted
        ? `Could not check detection for ${target.origin}, but browser site access remains. Use Disable or remove access in Chrome settings.`
        : 'Could not check site detection. Reopen the popup; check Chrome settings if site access remains.';
      return;
    }
    enabled = response.enabled;
    permitted = response.permitted;
    controls();
    siteStatus.textContent = response.enabled && !response.permitted
      ? 'Detection preference enabled; browser site access is absent. Use Disable to reset, then Enable.'
      : response.enabled
      ? `Detection enabled for ${target.origin}; browser access granted, not a completed scan.`
      : response.permitted ? 'Detection off; browser site access remains. Use Disable to remove it.'
        : 'Detection off; no browser site access.';
  } catch { siteStatus.textContent = 'Could not check this site. Reopen the popup.'; }
})();

async function recoverEnable(target: { id: number; origin: string }, unsafe = false): Promise<void> {
  async function current(): Promise<boolean> {
    let matches = false;
    try { matches = await sameSite(target); } catch { /* Cannot verify the target. */ }
    if (site !== target || !matches) { invalidateSite(); return false; }
    return true;
  }
  if (!await current()) return;
  let access: boolean | undefined;
  try { access = await chrome.permissions.contains({ origins: [`${target.origin}/*`] }); }
  catch { /* Unknown browser access needs a settings remedy. */ }
  if (!await current()) return;
  const response = await siteMessage(CLEARCHOICE_SITE_STATUS, target.origin);
  if (!await current()) return;
  // Browser access alone cannot establish whether the independent enable completed.
  if (access !== undefined) permitted = access;
  if (access === true && response.ok && response.enabled && response.permitted && !unsafe) {
    enabled = true;
    workerUnavailable = false;
    siteStatus.textContent = `Detection enabled for ${target.origin}; browser access granted, not a completed scan.`;
    return;
  }
  workerUnavailable = true;
  siteStatus.textContent = unsafe || (!response.ok && response.error === 'revocation-unsafe')
    ? `Detection state is unsafe for ${target.origin}. Remove site access in Chrome settings before restarting the browser.`
    : `Could not enable detection with confirmation for ${target.origin}; enable completion is unknown. ${access === true
      ? 'browser site access remains; use Disable or remove access in Chrome settings.'
      : access === false ? 'Browser site access is currently absent. Reopen the popup to check detection.'
        : 'Browser site access could not be checked. Check or remove access in Chrome settings.'}`;
}

enableButton.addEventListener('click', () => {
  if (busy || !site || enableButton.disabled) return;
  const target = site;
  busy = true; revision++;
  controls();
  siteStatus.textContent = `Requesting access to ${target.origin}…`;
  // Synchronous send preserves Chrome's gesture for the worker's request call.
  let completion: Promise<unknown>;
  try { completion = chrome.runtime.sendMessage({ type: CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION, origin: target.origin, tabId: target.id }); }
  catch { completion = Promise.reject(new Error('Enable request failed')); }
  void (async () => {
    try {
      const result = await completion;
      const response: SiteResponse = isSiteResponse(result) ? result : { ok: false, error: 'request-failed' };
      const matches = await sameSite(target);
      if (site !== target || !matches) {
        site = undefined;
        siteStatus.textContent = `Active tab changed after the enable request for ${target.origin}. Check this site's detection and access in Chrome settings.`;
        return;
      }
      if (!response.ok && response.error === 'permission-denied') { siteStatus.textContent = `Access denied for ${target.origin}; detection remains off.`; return; }
      if (!response.ok && response.error === 'operation-expired') { invalidateSite(); siteStatus.textContent = 'Enable request expired or the active tab changed. Reopen the popup to check detection.'; return; }
      if (!response.ok || !response.enabled || !response.permitted) {
        await recoverEnable(target, !response.ok && response.error === 'revocation-unsafe');
        return;
      }
      enabled = true;
      permitted = response.permitted;
      siteStatus.textContent = `Detection enabled for ${target.origin}; browser access granted, not a completed scan.`;
      controls();
    } catch { await recoverEnable(target); }
    finally { busy = false; controls(); }
  })();
});

disableButton.addEventListener('click', () => {
  if (busy || !site || disableButton.disabled) return;
  const target = site;
  busy = true; revision++;
  controls();
  siteStatus.textContent = `Disabling detection for ${target.origin}…`;
  void (async () => {
    try {
      if (!await sameSite(target)) { site = undefined; siteStatus.textContent = 'Active tab changed. Reopen the popup; no site was changed.'; return; }
      const response = await siteMessage(CLEARCHOICE_SITE_REVOKE, target.origin);
      if (response.ok) enabled = response.enabled;
      if (!await sameSite(target)) {
        site = undefined;
        siteStatus.textContent = `Active tab changed after revoking ${target.origin}. Browser access may remain; remove it in Chrome settings.`;
        return;
      }
      // Removal is exact-site only; a broader Chrome site grant may survive this request.
      let removed = false;
      try { removed = await chrome.permissions.remove({ origins: [`${target.origin}/*`] }); }
      catch { /* Explicit status below, never claim browser access was removed. */ }
      const stillPermitted = await chrome.permissions.contains({ origins: [`${target.origin}/*`] });
      permitted = stillPermitted;
      if (!response.ok || response.enabled || !removed || stillPermitted) {
        siteStatus.textContent = `Revocation incomplete for ${target.origin}. Remove site access in Chrome settings before restarting the browser; detection state and browser access may differ.`;
        return;
      }
      siteStatus.textContent = `Detection disabled and browser site access removed for ${target.origin}.`;
    } catch {
      siteStatus.textContent = `Revocation could not be confirmed for ${target.origin}. Remove site access in Chrome settings before restarting the browser.`;
    } finally { busy = false; controls(); }
  })();
});

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
  if (response.status === 'unsupported-context') return 'This isn’t a supported checkout page. Open a checkout page to use Analyze.';
  return findingStatus(response.findingCount);
}

async function analyzeActiveTab(): Promise<AnalyzeResponse> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_ANALYZE });
    return isAnalyzeResponse(response) ? response : { ok: false, error: 'request-failed' };
  } catch { return { ok: false, error: 'request-failed' }; }
}
async function restoreActiveTab() {
  try {
    const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_RESTORE });
    return isRestoreResponse(response) ? response : { ok: false as const, error: 'request-failed' as const };
  } catch { return { ok: false as const, error: 'request-failed' as const }; }
}

analyzeButton.addEventListener('click', async () => {
  if (analysisPending) return;
  analysisPending = true; analyzeButton.disabled = true; restoreButton.disabled = true;
  status.setAttribute('aria-busy', 'true');
  status.textContent = 'Analyzing this tab locally…';

  try {
    status.textContent = analysisStatus(await analyzeActiveTab());
  } finally {
    analysisPending = false; analyzeButton.disabled = false; controls();
    status.setAttribute('aria-busy', 'false');
    void review.refresh();
  }
});

restoreButton.addEventListener('click', async () => {
  if (busy || analysisPending) return;
  analysisPending = true; restoreButton.disabled = true; analyzeButton.disabled = true;
  status.setAttribute('aria-busy', 'true');
  status.textContent = 'Restoring dismissed findings…';

  try {
    const response = await restoreActiveTab();
    status.textContent = response.ok
      ? 'Dismissal restored. Analyze again to show findings.'
      : 'ClearChoice could not restore dismissed findings. Reload and try again.';
  } finally {
    analysisPending = false; analyzeButton.disabled = false; controls();
    status.setAttribute('aria-busy', 'false');
  }
});
