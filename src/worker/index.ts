import { CLEARCHOICE_ANALYZE, CLEARCHOICE_DISMISSED_GET, CLEARCHOICE_DISMISSED_SET, CLEARCHOICE_RESTORE, CLEARCHOICE_SUBMIT, CLEARCHOICE_SITE_STATUS, CLEARCHOICE_SITE_ENABLE, CLEARCHOICE_SITE_REVOKE, CLEARCHOICE_FINDINGS_CHALLENGE, CLEARCHOICE_AUTO_STATUS, CLEARCHOICE_AUTO_DOCUMENT_STATUS, isAutomaticDocumentStatus, CLEARCHOICE_AUTO_SUBMIT, CLEARCHOICE_AUTO_START, CLEARCHOICE_REVIEW_LIST, CLEARCHOICE_REVIEW_MARK, CLEARCHOICE_REVIEW_DELETE, CLEARCHOICE_REVIEW_RETENTION, isAnalyzeResponse, isAutomaticObservation, isFindingsChallengeResponse, isRestoreResponse, isWorkerRequest } from '../shared/messages';
import { canonicalOrigin } from '../shared/models';
import { getDismissed, setDismissed, loadGrantState } from '../shared/storage';
import { isCurrentActiveTab } from '../shared/tab-analysis';
import { createWorkerStore, NonRetryableFindingError, ScanAuthorizationError } from './store';
import { createGrantManager } from './grants';
import { createTabBadges } from './badge';

const badges = createTabBadges();

const store = createWorkerStore();
const grants = createGrantManager(store);
chrome.permissions.onRemoved.addListener((removed) => {
  void (async () => {
    // Chrome's event may remove a broader pattern. Check each tracked origin;
    // do not blank unrelated sites, and do not wait behind a blocked scan.
    await Promise.allSettled(badges.origins().map(async (origin) => {
      if (canonicalOrigin(origin) && !await chrome.permissions.contains({ origins: [`${origin}/*`] }))
        await badges.clearOrigin(origin);
    }));
    await grants.onRemoved(removed.origins ?? []);
  })().catch(() => {
    // No authorization is granted from this event; the next startup retries reconciliation.
  });
});
// Fail closed: retry failed setup on the next request, but share each in-flight attempt.
async function initialize(): Promise<boolean> {
  try {
    const access = await Promise.allSettled([
      chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    ]);
    if (access.some((entry) => entry.status === 'rejected')) return false;
    await store.readHistory();
    await grants.reconcile();
    return true;
  } catch { return false; }
}
let ready: Promise<boolean> | undefined;
function ensureReady(): Promise<boolean> {
  if (!ready) ready = initialize().then((ok) => { if (!ok) ready = undefined; return ok; });
  return ready;
}
void ensureReady();
const pending = new Map<string, { tabId: number; documentId: string; nonce: string; requestId: string; origin: string; count?: number }>();
const revoking = new Set<string>();
function retireTab(tabId: number): void {
  for (const [id, scan] of pending) if (scan.tabId === tabId) pending.delete(id);
  void badges.clearTab(tabId).catch(() => undefined);
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url !== undefined) retireTab(tabId);
});
chrome.tabs.onRemoved.addListener(retireTab);
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
async function liveChallenge(tabId: number, documentId: string, requestId: string): Promise<boolean> {
  try {
    // documentId can address a retained old document. frameId additionally asks
    // the CURRENT top frame to attest the same unpredictable in-flight ID.
    for (const target of [{ documentId }, { frameId: 0 }]) {
      const nonce = token();
      const response: unknown = await chrome.tabs.sendMessage(tabId, {
        type: CLEARCHOICE_FINDINGS_CHALLENGE, version: 1, requestId, nonce,
      }, target);
      if (!isFindingsChallengeResponse(response) || response.requestId !== requestId || response.nonce !== nonce) return false;
    }
    return true;
  } catch { return false; }
}
async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  try {
    if (!(await ensureReady())) return (isAutomaticObservation(message) || isAutomaticDocumentStatus(message)) && contentSender(sender)
      ? { ok: false, error: 'retryable-failure' } : { ok: false, error: 'request-failed' };
    if (!isWorkerRequest(message)) return { ok: false, error: 'request-failed' };
    const request = message as Record<string, unknown>;
    if (request.type === CLEARCHOICE_AUTO_STATUS) {
      // Read-only grant checks cannot wait on history's queue: its challenge may
      // be awaiting this very bootstrap. Tracking uses the independent UI queue.
      return await (async () => {
        if (!contentSender(sender)) return { ok: false, error: 'request-failed' };
        const origin = senderOrigin(sender.origin ?? sender.url);
        if (!origin || revoking.has(origin) || senderOrigin(sender.url) !== origin) return { ok: false, error: 'request-failed' };
        const tabId = sender.tab!.id!;
        const badge = badges.capture(tabId, origin);
        const tab = await chrome.tabs.get(tabId);
        if (tab.id !== tabId || senderOrigin(tab.url) !== origin) return { ok: false, error: 'request-failed' };
        const state = await loadGrantState();
        const grant = state.sites[origin];
        if (!grant?.enabled || !await grants.isEnabled(origin, grant.generation)) return { ok: false, error: 'request-failed' };
        const current = await chrome.tabs.get(tabId);
        if (current.id !== tabId || senderOrigin(current.url) !== origin
          || !await grants.isEnabled(origin, grant.generation)) return { ok: false, error: 'request-failed' };
        if (!await badges.trackAutomatic(badge, sender.documentId!) || !await grants.isEnabled(origin, grant.generation)) return { ok: false, error: 'request-failed' };
        return { ok: true, generation: grant.generation };
      })();
    }
    if (request.type === CLEARCHOICE_AUTO_DOCUMENT_STATUS) {
      if (!isAutomaticDocumentStatus(message) || !contentSender(sender)) return { ok: false, error: 'request-failed' };
      const origin = senderOrigin(sender.origin ?? sender.url);
      if (!origin || senderOrigin(sender.url) !== origin) return { ok: false, error: 'request-failed' };
      const tabId = sender.tab!.id!;
      const badge = badges.capture(tabId, origin);
      const checkpoint = async (): Promise<boolean> => {
        if (revoking.has(origin) || !badges.current(badge) || !await grants.isEnabled(origin, message.generation)) return false;
        const tab = await chrome.tabs.get(tabId);
        return tab.id === tabId && senderOrigin(tab.url) === origin && await grants.isEnabled(origin, message.generation);
      };
      if (!await checkpoint() || !await liveChallenge(tabId, sender.documentId!, message.requestId) || !await checkpoint())
        return { ok: false, error: 'request-failed' };
      // Challenge outside both queues. A revoked generation is rechecked under
      // the history/grant queue immediately before the short UI side effect.
      // Zero here is only the badge helper's blank sentinel, not a finding receipt.
      // Unavailable/overflow must never write history or claim zero findings.
      const published = await store.enqueue(async () => await checkpoint()
        && await badges.publish(badge, sender.documentId!, message.generation, 0));
      return published ? { ok: true } : { ok: false, error: 'request-failed' };
    }
    if (request.type === CLEARCHOICE_AUTO_SUBMIT) {
      if (!isAutomaticObservation(message) || !contentSender(sender)) return { ok: false, error: 'request-failed' };
      const tabId = sender.tab!.id!;
      const documentId = sender.documentId!;
      const origin = senderOrigin(sender.origin ?? sender.url);
      if (!origin || senderOrigin(sender.url) !== origin) return { ok: false, error: 'request-failed' };
      const badge = badges.capture(tabId, origin);
      const checkpoint = async (): Promise<boolean> => {
        if (revoking.has(origin) || !badges.current(badge) || !await grants.isEnabled(origin, message.generation)) return false;
        const tab = await chrome.tabs.get(tabId);
        return tab.id === tabId && senderOrigin(tab.url) === origin
          && await grants.isEnabled(origin, message.generation);
      };
      const challenge = () => liveChallenge(tabId, documentId, message.batch.requestId);
      const checked = async (): Promise<'authorized' | 'denied' | 'retryable'> => {
        try { return await checkpoint() ? 'authorized' : 'denied'; }
        catch { return 'retryable'; }
      };
      const before = await checked();
      if (before !== 'authorized') return { ok: false, error: before === 'retryable' ? 'retryable-failure' : 'request-failed' };
      if (!await challenge()) return { ok: false, error: 'request-failed' };
      const after = await checked();
      if (after !== 'authorized') return { ok: false, error: after === 'retryable' ? 'retryable-failure' : 'request-failed' };
      let result: { ids: string[] };
      try {
        result = await store.upsertFindings(message.batch, origin, async () =>
          await checkpoint() && await challenge() && await checkpoint());
      } catch (error) {
        return { ok: false, error: error instanceof ScanAuthorizationError || error instanceof NonRetryableFindingError
          ? 'request-failed' : 'retryable-failure' };
      }
      if (!await challenge()) return { ok: false, error: 'request-failed' };
      const published = await store.enqueue(async () => await checkpoint()
        && await badges.publish(badge, documentId, message.generation, result.ids.length));
      if (!published) return { ok: false, error: 'request-failed' };
      return { ok: true, findingCount: result.ids.length };
    }
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
      const tabId = sender.tab!.id!;
      const scan = pending.get(sender.documentId!);
      const manuallyAuthorized = (scan && scan.tabId === tabId && scan.origin === origin)
        || await authorizedDocument(tabId, sender.documentId!, origin);
      let automaticallyAuthorized = false;
      if (!manuallyAuthorized) {
        const state = await loadGrantState();
        const grant = state.sites[origin];
        automaticallyAuthorized = grant?.enabled === true && await grants.isEnabled(origin, grant.generation);
      }
      if (!manuallyAuthorized && !automaticallyAuthorized) return { ok: false, error: 'request-failed' };
      if ((!automaticallyAuthorized && !(await isCurrentActiveTab(tabId)))
        || senderOrigin((await chrome.tabs.get(tabId)).url) !== origin) return { ok: false, error: 'request-failed' };
      if (request.type === CLEARCHOICE_DISMISSED_GET) return { ok: true, dismissed: await getDismissed() };
      await setDismissed(request.dismissed as boolean);
      return { ok: true };
    }
    if (!popupSender(sender)) return { ok: false, error: 'request-failed' };
    if (request.type === CLEARCHOICE_REVIEW_LIST) {
      const { history, retentionPolicy } = await store.readReviewSnapshot();
      history.sort((a, b) => b.latestSeen.localeCompare(a.latestSeen) || a.id.localeCompare(b.id));
      const offset = request.offset as number;
      const findings = history.slice(offset, offset + (request.limit as number)).map((item) => ({
        id: item.id, origin: item.origin, kind: item.kind, reason: item.reason,
        screenedExcerpt: item.screenedExcerpt, firstSeen: item.firstSeen,
        latestSeen: item.latestSeen, status: item.status,
      }));
      return { type: CLEARCHOICE_REVIEW_LIST, version: 1, offset, total: history.length,
        needsReviewCount: history.filter((item) => item.status === 'needs-review').length,
        retentionPolicy, findings };
    }
    if (request.type === CLEARCHOICE_REVIEW_MARK || request.type === CLEARCHOICE_REVIEW_DELETE
      || request.type === CLEARCHOICE_REVIEW_RETENTION) {
      if (request.type === CLEARCHOICE_REVIEW_MARK) await store.markReviewed(request.id);
      else if (request.type === CLEARCHOICE_REVIEW_DELETE) await store.deleteFinding(request.id);
      else await store.setRetentionPolicy(request.policy);
      return { ok: true };
    }
    if (request.type === CLEARCHOICE_SITE_STATUS || request.type === CLEARCHOICE_SITE_ENABLE || request.type === CLEARCHOICE_SITE_REVOKE) {
      const origin = request.origin as string;
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id === undefined || senderOrigin(active.url ?? (await chrome.tabs.get(active.id)).url) !== origin
        || !(await isCurrentActiveTab(active.id))) return { ok: false, error: 'request-failed' };
      // A second tab read guards against a same-tab navigation while the focus check awaits.
      if (senderOrigin((await chrome.tabs.get(active.id)).url) !== origin) return { ok: false, error: 'request-failed' };
      if (request.type === CLEARCHOICE_SITE_ENABLE) {
        const currentSite = async () => await isCurrentActiveTab(active.id!)
          && senderOrigin((await chrome.tabs.get(active.id!)).url) === origin;
        const { generation, newlyEnabled } = await grants.enable(origin, currentSite);
        try {
          if (!await currentSite() || !await grants.isEnabled(origin, generation)) throw new Error('Bootstrap site changed');
          // An inert top-frame probe supplies the document ID; tabs.Tab has none.
          const probe = await chrome.scripting.executeScript({ target: { tabId: active.id }, func: () => undefined });
          const top = probe.find((entry) => entry.frameId === 0 && typeof entry.documentId === 'string' && entry.documentId.length > 0);
          if (!top || !await currentSite() || !await grants.isEnabled(origin, generation)) throw new Error('Bootstrap document unavailable');
          await chrome.scripting.executeScript({ target: { tabId: active.id, documentIds: [top.documentId!] }, files: ['content.js'] });
          if (!await currentSite() || !await grants.isEnabled(origin, generation)) throw new Error('Bootstrap site changed');
          const started: unknown = await chrome.tabs.sendMessage(active.id, { type: CLEARCHOICE_AUTO_START, version: 1, generation }, { documentId: top.documentId! });
          if (typeof started !== 'object' || started === null || Object.keys(started).length !== 1
            || !('ok' in started) || started.ok !== true || !await currentSite()
            || !await grants.isEnabled(origin, generation)) throw new Error('Bootstrap start refused');
        } catch {
          if (newlyEnabled) {
            try { await grants.rollbackEnable(origin, generation); }
            catch { return { ok: false, error: 'revocation-unsafe' }; }
            return { ok: false, error: 'request-failed' };
          }
          // A prior opt-in remains in force: report its actual state, not a revoked grant.
          if (!await currentSite() || !await grants.isEnabled(origin, generation)) return { ok: false, error: 'request-failed' };
          return { ok: true, enabled: true, permitted: true };
        }
      }
      if (request.type === CLEARCHOICE_SITE_REVOKE) {
        revoking.add(origin);
        try {
          // Retire queued/in-flight badge work before the grant queue can block.
          await badges.clearOrigin(origin).catch(() => undefined);
          await grants.revoke(origin);
        }
        catch (error) {
          return { ok: false, error: error instanceof Error && error.message.startsWith('Revocation could not be confirmed')
            ? 'revocation-unsafe' : 'request-failed' };
        } finally { revoking.delete(origin); }
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
    const initialOrigin = senderOrigin((await chrome.tabs.get(tabId)).url);
    const badge = badges.capture(tabId, initialOrigin ?? '');
    let injected: chrome.scripting.InjectionResult[];
    try {
      injected = await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, error: /cannot access|extensions gallery|webstore|cannot script.*extension/i.test(text) ? 'restricted-page' : 'injection-failed' };
    }
    const top = injected.find((result) => result.frameId === 0 && typeof result.documentId === 'string' && result.documentId.length > 0);
    if (!top || !badges.current(badge) || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
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
    if (!origin || origin !== initialOrigin || !badges.current(badge) || !(await isCurrentActiveTab(tabId))) return { ok: false, error: 'request-failed' };
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
      if (response.ok) {
        if (!badges.current(badge) || pending.get(documentId) !== scan
          || senderOrigin((await chrome.tabs.get(tabId)).url) !== origin || !await isCurrentActiveTab(tabId)
          || !await badges.publish(badge, documentId, 0, response.findingCount)) return { ok: false, error: 'request-failed' };
      }
      return response;
    } finally { if (pending.get(documentId) === scan) pending.delete(documentId); }
  } catch { return { ok: false, error: isAutomaticDocumentStatus(message) && contentSender(sender) ? 'retryable-failure' : 'request-failed' }; }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  void handle(message, sender).then(reply);
  return true;
});
