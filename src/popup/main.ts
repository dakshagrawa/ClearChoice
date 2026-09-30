import { mountReview } from './review';
import type { AnalyzeResponse, SiteResponse } from '../shared/messages';
import { CLEARCHOICE_ANALYZE, CLEARCHOICE_RESTORE, CLEARCHOICE_SITE_STATUS, CLEARCHOICE_SITE_ENABLE, CLEARCHOICE_SITE_REVOKE, isAnalyzeResponse, isRestoreResponse, isSiteResponse } from '../shared/messages';
import { isGrantOrigin } from '../shared/storage';

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
    <section aria-label="Site detection">
      <p>Optional detection on supported English checkout pages only. Observations stay local; panels appear only after findings are saved. Enabling a site does not confirm a completed scan.</p>
      <button type="button" data-action="site-enable" disabled>Enable detection for this site</button>
      <button type="button" data-action="site-disable" disabled>Disable detection for this site</button>
      <p data-site-status role="status" aria-live="polite">Checking this site…</p>
    </section>
  </main>
`;

const reviewRoot = document.createElement('div');
app.querySelector('main')!.append(reviewRoot);
const review = mountReview(reviewRoot);

const analyzeButton = app.querySelector<HTMLButtonElement>('[data-action="analyze"]');
const restoreButton = app.querySelector<HTMLButtonElement>('[data-action="restore"]');
const status = app.querySelector<HTMLParagraphElement>('[role="status"]');

if (!analyzeButton || !restoreButton || !status) throw new Error('ClearChoice popup controls are missing.');

const enableButton = app.querySelector<HTMLButtonElement>('[data-action="site-enable"]')!;
const disableButton = app.querySelector<HTMLButtonElement>('[data-action="site-disable"]')!;
const siteStatus = app.querySelector<HTMLParagraphElement>('[data-site-status]')!;
let site: { id: number; origin: string } | undefined;
let busy = false;
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
        ? `Could not check detection for ${target.origin}, but browser site access remains. Use Disable below or remove access in Chrome settings.`
        : 'Could not check site detection. Reopen the popup; check Chrome settings if site access remains.';
      return;
    }
    enabled = response.enabled;
    permitted = response.permitted;
    controls();
    siteStatus.textContent = response.enabled
      ? `Detection enabled for ${target.origin}; supported English checkout detection is enabled, not a completed scan.`
      : response.permitted ? `Detection off for ${target.origin}; browser site access remains. You can remove it below.`
        : `Detection off for ${target.origin}.`;
  } catch { siteStatus.textContent = 'Could not check this site. Reopen the popup.'; }
})();

enableButton.addEventListener('click', () => {
  if (busy || !site || enableButton.disabled) return;
  const target = site;
  busy = true; revision++;
  controls();
  siteStatus.textContent = `Requesting access to ${target.origin}…`;
  // This call must occur on the click stack: an awaited tab lookup loses Chrome's user gesture.
  let permission: Promise<boolean>;
  try { permission = chrome.permissions.request({ origins: [`${target.origin}/*`] }); }
  catch { permission = Promise.reject(new Error('Permission request failed')); }
  void (async () => {
    try {
      const allowed = await permission;
      if (!allowed) { siteStatus.textContent = `Access denied for ${target.origin}; detection remains off.`; return; }
      permitted = true;
      if (site !== target || !await sameSite(target)) { site = undefined; siteStatus.textContent = `Active tab changed. Detection was not enabled for ${target.origin}; browser site access may remain. Remove it in Chrome settings if unwanted.`; return; }
      const response = await siteMessage(CLEARCHOICE_SITE_ENABLE, target.origin);
      if (site !== target || !await sameSite(target)) {
        site = undefined;
        siteStatus.textContent = `Active tab changed after the enable request for ${target.origin}. Check this site's detection and access in Chrome settings.`;
        return;
      }
      if (!response.ok && response.error === 'revocation-unsafe') { siteStatus.textContent = `Detection state is unsafe for ${target.origin}. Remove site access in Chrome settings before restarting the browser.`; return; }
      if (!response.ok || !response.enabled || !response.permitted) { siteStatus.textContent = `Could not enable detection for ${target.origin}. Browser site access may remain; use Disable below or Chrome settings.`; return; }
      enabled = true;
      permitted = response.permitted;
      siteStatus.textContent = `Detection enabled for ${target.origin}; supported English checkout detection is enabled, not a completed scan.`;
      controls();
    } catch { siteStatus.textContent = `Access request failed for ${target.origin}; detection remains off.`; }
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
  if (response.status === 'unsupported-context') return 'This page does not look like a supported English checkout page.';
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
  analyzeButton.disabled = true;
  status.textContent = 'Analyzing this tab locally…';

  try {
    status.textContent = analysisStatus(await analyzeActiveTab());
  } finally {
    analyzeButton.disabled = false;
    void review.refresh();
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
