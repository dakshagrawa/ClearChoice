import { CLEARCHOICE_ANALYZE, CLEARCHOICE_DISMISSED_GET, CLEARCHOICE_DISMISSED_SET, CLEARCHOICE_RESTORE, CLEARCHOICE_SUBMIT, isAnalyzeResponse, isRestoreResponse, isWorkerRequest } from '../shared/messages';
import { canonicalOrigin } from '../shared/models';
import { getDismissed, setDismissed } from '../shared/storage';
import { isCurrentActiveTab } from '../shared/tab-analysis';
import { createWorkerStore } from './store';

const store = createWorkerStore();
// Fail closed: no content injection until trusted-only access and queued retention read succeed.
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .then(() => store.readHistory()).then(() => true, () => false);
const pending = new Map<string, { tabId: number; documentId: string; nonce: string; requestId: string; origin: string; count?: number }>();
const authorized = new Map<number, { documentId: string; origin: string }>();
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
      const result = await store.upsertFindings(request.batch, scan.origin);
      if (!(await isCurrentActiveTab(scan.tabId))) return { ok: false, error: 'request-failed' };
      scan.count = result.ids.length;
      return { ok: true, findingCount: result.ids.length };
    }
    if (request.type === CLEARCHOICE_DISMISSED_GET || request.type === CLEARCHOICE_DISMISSED_SET) {
      if (!contentSender(sender)) return { ok: false, error: 'request-failed' };
      const scan = pending.get(sender.documentId!);
      const grant = authorized.get(sender.tab!.id!);
      if (!(scan && scan.tabId === sender.tab!.id && scan.origin === senderOrigin(sender.url))
        && !(grant && grant.documentId === sender.documentId && grant.origin === senderOrigin(sender.url)))
        return { ok: false, error: 'request-failed' };
      if (!(await isCurrentActiveTab(sender.tab!.id!))) return { ok: false, error: 'request-failed' };
      if (request.type === CLEARCHOICE_DISMISSED_GET) return { ok: true, dismissed: await getDismissed() };
      await setDismissed(request.dismissed as boolean);
      return { ok: true };
    }
    if (!popupSender(sender)) return { ok: false, error: 'request-failed' };
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
      pending.set(documentId, { tabId, documentId, nonce: token(), requestId: token(), origin });
      try {
        const response: unknown = await chrome.tabs.sendMessage(tabId, { type: CLEARCHOICE_RESTORE }, { documentId });
        if (!(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
        return isRestoreResponse(response) ? response : { ok: false, error: 'request-failed' };
      } finally { pending.delete(documentId); }
    }
    const requestId = token();
    const nonce = token();
    const tabDetails = await chrome.tabs.get(tabId);
    const origin = senderOrigin(tabDetails.url);
    if (!origin || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
    // Focus and document checks are checkpoints, not atomic with the subsequent send:
    // a switch in the check-to-send interval remains a browser-level race.
    pending.set(documentId, { tabId, documentId, nonce, requestId, origin });
    try {
      const response: unknown = await chrome.tabs.sendMessage(tabId, { type: CLEARCHOICE_ANALYZE, requestId, nonce }, { documentId });
      if (!(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
      if (!isAnalyzeResponse(response)) return { ok: false, error: 'request-failed' };
      if (response.ok && response.status === 'supported') {
        if (pending.get(documentId)?.count === undefined) return { ok: false, error: 'request-failed' };
        authorized.set(tabId, { documentId, origin });
      }
      return response;
    } finally { pending.delete(documentId); }
  } catch { return { ok: false, error: 'request-failed' }; }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  void handle(message, sender).then(reply);
  return true;
});
