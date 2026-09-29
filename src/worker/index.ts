import { CLEARCHOICE_ANALYZE, CLEARCHOICE_DISMISSED_GET, CLEARCHOICE_DISMISSED_SET, CLEARCHOICE_RESTORE, CLEARCHOICE_SUBMIT, CLEARCHOICE_SITE_STATUS, CLEARCHOICE_SITE_ENABLE, CLEARCHOICE_SITE_REVOKE, isAnalyzeResponse, isRestoreResponse, isWorkerRequest } from '../shared/messages';
import { canonicalOrigin } from '../shared/models';
import { getDismissed, setDismissed, loadGrantState } from '../shared/storage';
import { isCurrentActiveTab } from '../shared/tab-analysis';
import { createWorkerStore } from './store';
import { createGrantManager } from './grants';

const store = createWorkerStore();
const grants = createGrantManager(store);
chrome.permissions.onRemoved.addListener((removed) => {
  void grants.onRemoved(removed.origins ?? []).catch(() => {
    // No authorization is granted from this event; the next startup retries reconciliation.
  });
});
// Fail closed: no content injection until trusted-only access, retention read and grant reconciliation succeed.
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]).then(() => store.readHistory()).then(() => grants.reconcile()).then(() => true, () => false);
const pending = new Map<string, { tabId: number; documentId: string; nonce: string; requestId: string; origin: string; count?: number }>();
const authorizationKey = (tabId: number): string => `clearchoice.document.${tabId}`;
async function authorizedDocument(tabId: number, documentId: string, origin: string): Promise<boolean> {
  const key = authorizationKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    && Object.keys(stored).length === 3 && Object.keys(stored).every((field) => ['tabId', 'documentId', 'origin'].includes(field))
    && (stored as Record<string, unknown>).tabId === tabId
    && (stored as Record<string, unknown>).documentId === documentId
    && (stored as Record<string, unknown>).origin === origin;
}
function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function senderOrigin(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const origin = new URL(url).origin;
    return canonicalOrigin(origin) ? origin : undefined;
  } catch { return undefined; }
}
function contentSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab?.id !== undefined && sender.frameId === 0
    && typeof sender.documentId === 'string' && sender.documentId.length > 0;
}
function popupSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined
    && sender.url === `chrome-extension://${chrome.runtime.id}/popup/index.html`;
}
async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  try {
    if (!(await ready)) return { ok: false, error: 'request-failed' };
    if (!isWorkerRequest(message)) return { ok: false, error: 'request-failed' };
    const request = message as Record<string, unknown>;
    if (request.type === CLEARCHOICE_SUBMIT) {
      if (!contentSender(sender)) return { ok: false, error: 'request-failed' };
      const scan = pending.get(sender.documentId!);
      const batch = request.batch as { requestId: string };
      if (!scan || scan.tabId !== sender.tab!.id || scan.nonce !== request.nonce
        || scan.requestId !== batch.requestId || senderOrigin(sender.url) !== scan.origin
        || !(await isCurrentActiveTab(scan.tabId))) return { ok: false, error: 'request-failed' };
      const result = await store.upsertFindings(request.batch, scan.origin, async () => {
        if (pending.get(scan.documentId) !== scan || scan.tabId !== sender.tab?.id
          || scan.documentId !== sender.documentId || scan.nonce !== request.nonce
          || scan.requestId !== batch.requestId || senderOrigin(sender.url) !== scan.origin) return false;
        const tabDetails = await chrome.tabs.get(scan.tabId);
        return senderOrigin(tabDetails.url) === scan.origin && pending.get(scan.documentId) === scan
          && await isCurrentActiveTab(scan.tabId);
      });
      if (!(await isCurrentActiveTab(scan.tabId))) return { ok: false, error: 'request-failed' };
      scan.count = result.ids.length;
      return { ok: true, findingCount: result.ids.length };
    }
    if (request.type === CLEARCHOICE_DISMISSED_GET || request.type === CLEARCHOICE_DISMISSED_SET) {
      if (!contentSender(sender)) return { ok: false, error: 'request-failed' };
      const origin = senderOrigin(sender.url);
      if (!origin) return { ok: false, error: 'request-failed' };
      const scan = pending.get(sender.documentId!);
      if (!(scan && scan.tabId === sender.tab!.id && scan.origin === origin)
        && !(await authorizedDocument(sender.tab!.id!, sender.documentId!, origin)))
        return { ok: false, error: 'request-failed' };
      if (!(await isCurrentActiveTab(sender.tab!.id!))
        || senderOrigin((await chrome.tabs.get(sender.tab!.id!)).url) !== origin) return { ok: false, error: 'request-failed' };
      if (request.type === CLEARCHOICE_DISMISSED_GET) return { ok: true, dismissed: await getDismissed() };
      await setDismissed(request.dismissed as boolean);
      return { ok: true };
    }
    if (!popupSender(sender)) return { ok: false, error: 'request-failed' };
    if (request.type === CLEARCHOICE_SITE_STATUS || request.type === CLEARCHOICE_SITE_ENABLE || request.type === CLEARCHOICE_SITE_REVOKE) {
      const origin = request.origin as string;
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id === undefined || senderOrigin(active.url ?? (await chrome.tabs.get(active.id)).url) !== origin
        || !(await isCurrentActiveTab(active.id))) return { ok: false, error: 'request-failed' };
      // A second tab read guards against a same-tab navigation while the focus check awaits.
      if (senderOrigin((await chrome.tabs.get(active.id)).url) !== origin) return { ok: false, error: 'request-failed' };
      if (request.type === CLEARCHOICE_SITE_ENABLE) await grants.enable(origin);
      if (request.type === CLEARCHOICE_SITE_REVOKE) {
        try { await grants.revoke(origin); }
        catch (error) {
          return { ok: false, error: error instanceof Error && error.message.startsWith('Revocation could not be confirmed')
            ? 'revocation-unsafe' : 'request-failed' };
        }
      }
      if (!(await isCurrentActiveTab(active.id)) || senderOrigin((await chrome.tabs.get(active.id)).url) !== origin)
        return { ok: false, error: 'request-failed' };
      const state = await loadGrantState();
      const permitted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      return { ok: true, enabled: state.sites[origin]?.enabled === true && permitted
        && await grants.isEnabled(origin, state.sites[origin].generation), permitted };
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;
    if (tabId === undefined || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
    let injected: chrome.scripting.InjectionResult[];
    try {
      injected = await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, error: /cannot access|extensions gallery|webstore|cannot script.*extension/i.test(text) ? 'restricted-page' : 'injection-failed' };
    }
    const top = injected.find((result) => result.frameId === 0 && typeof result.documentId === 'string' && result.documentId.length > 0);
    if (!top || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
    const documentId = top.documentId!;
    if (request.type === CLEARCHOICE_RESTORE) {
      const tabDetails = await chrome.tabs.get(tabId);
      const origin = senderOrigin(tabDetails.url);
      if (!origin || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
      const scan = { tabId, documentId, nonce: token(), requestId: token(), origin };
      pending.set(documentId, scan);
      try {
        const response: unknown = await chrome.tabs.sendMessage(tabId, { type: CLEARCHOICE_RESTORE }, { documentId });
        if (pending.get(documentId) !== scan || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
        return isRestoreResponse(response) ? response : { ok: false, error: 'request-failed' };
      } finally { if (pending.get(documentId) === scan) pending.delete(documentId); }
    }
    const requestId = token();
    const nonce = token();
    const tabDetails = await chrome.tabs.get(tabId);
    const origin = senderOrigin(tabDetails.url);
    if (!origin || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
    // Focus and document checks are checkpoints, not atomic with the subsequent send:
    // a switch in the check-to-send interval remains a browser-level race.
    const scan = { tabId, documentId, nonce, requestId, origin, count: undefined as number | undefined };
    pending.set(documentId, scan);
    try {
      const response: unknown = await chrome.tabs.sendMessage(tabId, { type: CLEARCHOICE_ANALYZE, requestId, nonce }, { documentId });
      if (pending.get(documentId) !== scan || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
      if (!isAnalyzeResponse(response)) return { ok: false, error: 'request-failed' };
      if (response.ok && response.status === 'supported') {
        if (scan.count === undefined || response.findingCount !== scan.count) return { ok: false, error: 'request-failed' };
        await chrome.storage.session.set({ [authorizationKey(tabId)]: { tabId, documentId, origin } });
        if (pending.get(documentId) !== scan) return { ok: false, error: 'request-failed' };
      }
      return response;
    } finally { if (pending.get(documentId) === scan) pending.delete(documentId); }
  } catch { return { ok: false, error: 'request-failed' }; }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  void handle(message, sender).then(reply);
  return true;
});
