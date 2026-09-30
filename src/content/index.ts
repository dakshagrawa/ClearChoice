import { classifyCheckoutContext } from '../core/context';
import { detectPreselectedAddons, detectRecurringCharges } from '../core/detector';
import type { AnalysisResult, Finding } from '../core/types';
import {
  CLEARCHOICE_DISMISSED_GET,
  CLEARCHOICE_AUTO_SUBMIT,
  CLEARCHOICE_AUTO_STATUS,
  CLEARCHOICE_AUTO_DOCUMENT_STATUS,
  isAutomaticDocumentStatus,
  CLEARCHOICE_AUTO_START,
  CLEARCHOICE_FINDINGS_CHALLENGE,
  CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE,
  isAutomaticObservation,
  CLEARCHOICE_DISABLE,
  CLEARCHOICE_DISMISSED_SET,
  CLEARCHOICE_RESTORE,
  CLEARCHOICE_SUBMIT,
  isContentRequest,
} from '../shared/messages';
import type {
  AnalyzeResponse,
  AutomaticDocumentStatus,
  FindingsBatchRequest,
  RestoreResponse,
} from '../shared/messages';
import { buildFindingBatchWithSources, createScanRequestId } from './candidates';
import { isOwnedPanelMutation, removePanel, renderAutomaticDiagnostic, renderPanel } from './panel';

const contentSentinel = '__clearchoiceContentListenerInstalled__';
// Retired observers cannot attest a pending worker challenge or occupy a slot.
const automaticRequestIds = new Map<string, symbol>();
const automaticStatusIds = new Map<string, { live: () => boolean }>();
const maxPendingAutomaticRequests = 2;

export async function submitAutomaticStatus(generation: number, status: AutomaticDocumentStatus['status'], signal?: AbortSignal, live: () => boolean = () => true): Promise<void> {
  const requestId = createScanRequestId();
  const request = { type: CLEARCHOICE_AUTO_DOCUMENT_STATUS, version: 1, generation, requestId, status };
  if (signal?.aborted || !live() || automaticStatusIds.size >= maxPendingAutomaticRequests || !isAutomaticDocumentStatus(request)) throw new Error('Automatic status unavailable');
  const entry = { live };
  automaticStatusIds.set(requestId, entry);
  const retire = () => { if (automaticStatusIds.get(requestId) === entry) automaticStatusIds.delete(requestId); };
  signal?.addEventListener('abort', retire, { once: true });
  try {
    let reply: unknown;
    try { reply = await chrome.runtime.sendMessage(request); }
    catch { if (signal?.aborted || !live()) return; throw new AutomaticObservationFailure(true); }
    if (signal?.aborted || !live()) return; // A superseding DOM revision owns the next scan.
    if (typeof reply === 'object' && reply !== null && Object.keys(reply).length === 2
      && 'ok' in reply && reply.ok === false && 'error' in reply
      && (reply.error === 'retryable-failure' || reply.error === 'request-failed'))
      throw new AutomaticObservationFailure(reply.error === 'retryable-failure');
    if (typeof reply !== 'object' || reply === null || Object.keys(reply).length !== 1 || !('ok' in reply) || reply.ok !== true)
      throw new AutomaticObservationFailure(false);
  } finally { retire(); signal?.removeEventListener('abort', retire); }
}

export class AutomaticObservationFailure extends Error {
  constructor(readonly retryable: boolean) { super('Automatic observation refused'); }
}

/** Task 10 will call this only after its opt-in checkout observer screens a batch. */
export async function submitAutomaticObservation(generation: number, batch: FindingsBatchRequest, signal?: AbortSignal): Promise<{ ok: true; findingCount: number }> {
  const request = { type: CLEARCHOICE_AUTO_SUBMIT, version: 1, generation, batch };
  if (signal?.aborted || automaticRequestIds.size >= maxPendingAutomaticRequests || automaticRequestIds.has(batch.requestId)
    || !isAutomaticObservation(request)) throw new Error('Automatic observation unavailable');
  const token = Symbol();
  automaticRequestIds.set(batch.requestId, token);
  const retire = () => { if (automaticRequestIds.get(batch.requestId) === token) automaticRequestIds.delete(batch.requestId); };
  signal?.addEventListener('abort', retire, { once: true });
  try {
    let reply: unknown;
    try { reply = await chrome.runtime.sendMessage(request); }
    catch { throw new AutomaticObservationFailure(true); }
    if (typeof reply === 'object' && reply !== null && Object.keys(reply).length === 2
      && 'ok' in reply && reply.ok === false && 'error' in reply
      && (reply.error === 'retryable-failure' || reply.error === 'request-failed')) {
      throw new AutomaticObservationFailure(reply.error === 'retryable-failure');
    }
    if (typeof reply !== 'object' || reply === null || Object.keys(reply).length !== 2
      || !('ok' in reply) || reply.ok !== true || !('findingCount' in reply)
      || reply.findingCount !== batch.findings.length) throw new Error('Automatic observation refused');
    return { ok: true, findingCount: batch.findings.length };
  } finally { retire(); signal?.removeEventListener('abort', retire); }
}

async function getDismissed(): Promise<boolean> {
  const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_DISMISSED_GET });
  if (typeof response !== 'object' || response === null || Object.keys(response).length !== 2
    || !('ok' in response) || response.ok !== true || !('dismissed' in response)
    || typeof response.dismissed !== 'boolean') throw new Error('Dismissed read refused');
  return response.dismissed;
}
async function setDismissed(dismissed: boolean): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_DISMISSED_SET, dismissed });
  if (typeof response !== 'object' || response === null || Object.keys(response).length !== 1
    || !('ok' in response) || response.ok !== true) throw new Error('Dismissed write refused');
}

type ClearChoiceWindow = Window & { [contentSentinel]?: true };

function inDomOrder(left: Finding, right: Finding): number {
  const leftElement = document.querySelector(left.selector);
  const rightElement = document.querySelector(right.selector);
  if (!leftElement || !rightElement || leftElement === rightElement) return left.id.localeCompare(right.id);
  return leftElement.compareDocumentPosition(rightElement) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function analyzePage(): AnalysisResult {
  return {
    findings: [
      ...detectRecurringCharges(document.documentElement),
      ...detectPreselectedAddons(document.documentElement),
    ].sort(inDomOrder),
  };
}

async function automaticGeneration(): Promise<number | undefined> {
  const response: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_AUTO_STATUS });
  if (typeof response !== 'object' || response === null || Object.keys(response).length !== 2
    || !('ok' in response) || response.ok !== true || !('generation' in response)
    || !Number.isSafeInteger(response.generation) || (response.generation as number) <= 0) return undefined;
  return response.generation as number;
}

/** The worker grants this document a generation before any DOM observer is installed. */
function startAutomaticObserver(): { stop: () => void; currentGeneration: () => number | undefined; ready: Promise<boolean> } {
  let active = true;
  const lifetime = new AbortController();
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let running = false;
  let revision = 0;
  let firstChange = 0;
  let lastSignature: string | undefined;
  let autoPanel: HTMLElement | undefined;
  const removeAutomaticPanel = () => {
    if (autoPanel?.isConnected) removePanel();
    autoPanel = undefined;
  };
  let retries = 0;
  const initialOrigin = location.origin;
  let generation: number | undefined;
  const valid = () => active && location.origin === initialOrigin;
  const stop = () => {
    if (!active) return;
    active = false;
    lifetime.abort();
    observer?.disconnect();
    if (timer) clearTimeout(timer);
    window.removeEventListener('popstate', queue);
    window.removeEventListener('hashchange', queue);
    window.removeEventListener('pagehide', stop);
    removeAutomaticPanel();
  };
  const queue = () => {
    if (!valid()) { stop(); return; }
    dirty = true;
    revision++;
    if (!firstChange) firstChange = Date.now();
    if (running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void scan(); }, Math.min(80, Math.max(0, 500 - (Date.now() - firstChange))));
  };
  const scan = async () => {
    if (!valid() || running || !dirty) return;
    running = true;
    dirty = false;
    firstChange = 0;
    const scanRevision = revision;
    const reportStatus = async (status: AutomaticDocumentStatus['status']) => {
      removeAutomaticPanel();
      if (lastSignature === status) return;
      // The worker may clear its count before this receipt arrives. A newer DOM
      // revision must republish even identical findings, not dedupe against them.
      lastSignature = undefined;
      await submitAutomaticStatus(generation!, status, lifetime.signal, () => valid() && revision === scanRevision);
      if (valid() && revision === scanRevision) { lastSignature = status; retries = 0; }
    };
    try {
      const currentGeneration = await automaticGeneration();
      if (!valid() || currentGeneration !== generation) { stop(); return; }
      if (classifyCheckoutContext(document.documentElement) === 'unsupported') {
        await reportStatus('unsupported-context');
        return;
      }
      const findings = analyzePage().findings;
      if (!findings.length) { await reportStatus('supported-zero'); return; }
      const { batch, eligibleFindings } = await buildFindingBatchWithSources(findings, createScanRequestId());
      if (!valid() || revision !== scanRevision) return;
      if (!batch.findings.length) { await reportStatus('supported-zero'); return; }
      const signature = JSON.stringify(batch.findings.map(({ kind, reason, screenedExcerpt, opaqueFingerprint, ordinal }) =>
        [kind, reason, screenedExcerpt, opaqueFingerprint, ordinal]));
      if (signature === lastSignature) return;
      await submitAutomaticObservation(generation!, batch, lifetime.signal);
      if (!valid() || revision !== scanRevision) return;
      if (await automaticGeneration() !== generation) { stop(); return; }
      if (!valid() || revision !== scanRevision || classifyCheckoutContext(document.documentElement) === 'unsupported') {
        removeAutomaticPanel(); return;
      }
      lastSignature = signature;
      retries = 0;
      const dismissed = await getDismissed();
      if (await automaticGeneration() !== generation) { stop(); return; }
      if (!dismissed && valid() && revision === scanRevision
        && classifyCheckoutContext(document.documentElement) === 'supported') {
        autoPanel = renderPanel({ findings: eligibleFindings.map((finding, index) => ({
          ...finding, evidence: batch.findings[index].screenedExcerpt,
        })) }, () => { void setDismissed(true).catch(() => undefined); });
      }
    } catch (error) {
      removeAutomaticPanel();
      if (error instanceof Error && error.message === 'Finding batch exceeds 100 eligible items') {
        try {
          if (!valid() || revision !== scanRevision) return;
          await reportStatus('unavailable-overflow');
          if (valid() && revision === scanRevision && !(await getDismissed())
            && await automaticGeneration() === generation && valid() && revision === scanRevision) {
            autoPanel = renderAutomaticDiagnostic(() => { void setDismissed(true).catch(() => undefined); });
          }
        } catch (statusError) {
          if (statusError instanceof AutomaticObservationFailure && statusError.retryable && retries++ < 1 && valid()) {
            queue();
          } else {
            stop();
          }
        }
      } else if (error instanceof AutomaticObservationFailure && error.retryable && retries++ < 1 && valid()) {
        queue();
      } else {
        // Deterministic denial and malformed receipts do not trigger automatic retries.
        stop();
      }
    } finally {
      running = false;
      if (dirty && valid()) queue();
    }
  };
  window.addEventListener('pagehide', stop);
  const ready = automaticGeneration().then((allowed) => {
    if (!valid() || allowed === undefined) { stop(); return false; }
    generation = allowed;
    observer = new MutationObserver((records) => {
      if (records.some((record) => !isOwnedPanelMutation(record))) queue();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    window.addEventListener('popstate', queue);
    window.addEventListener('hashchange', queue);
    queue();
    return true;
  }).catch(() => { stop(); return false; });
  return { stop, currentGeneration: () => active ? generation : undefined, ready };
}

const pageWindow = window as ClearChoiceWindow;
if (!pageWindow[contentSentinel]) {
  pageWindow[contentSentinel] = true;
  let automatic = startAutomaticObserver();
  const restartAutomatic = () => {
    if (automatic.currentGeneration() !== undefined) return;
    automatic.stop();
    automatic = startAutomaticObserver();
  };
  // BFCache retains the sentinel and listener; reauthorize before reinstalling one observer.
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) restartAutomatic(); };
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
    }
  };
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('pagehide', onPageHide);
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isContentRequest(message)) return;
    const request = message;

    void (async () => {
      if (request.type === CLEARCHOICE_FINDINGS_CHALLENGE) {
        if (sender.id === chrome.runtime.id && (automaticRequestIds.has(request.requestId) || automaticStatusIds.get(request.requestId)?.live())) {
          sendResponse({ type: CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE, version: 1,
            requestId: request.requestId, nonce: request.nonce });
        } else sendResponse({ ok: false, error: 'request-failed' });
        return;
      }
      if (request.type === CLEARCHOICE_AUTO_START) {
        if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false, error: 'request-failed' }); return; }
        const allowed = await automaticGeneration();
        if (allowed !== request.generation) { sendResponse({ ok: false, error: 'request-failed' }); return; }
        if (automatic.currentGeneration() !== allowed) {
          automatic.stop();
          automatic = startAutomaticObserver();
          if (!await automatic.ready || automatic.currentGeneration() !== allowed) {
            sendResponse({ ok: false, error: 'request-failed' }); return;
          }
        }
        sendResponse({ ok: true });
        return;
      }
      if (request.type === CLEARCHOICE_DISABLE) {
        automatic.stop();
        removePanel();
        sendResponse({ ok: true });
        return;
      }
      if (request.type === CLEARCHOICE_RESTORE) {
        removePanel();
        await setDismissed(false);
        sendResponse({ ok: true } satisfies RestoreResponse);
        return;
      }

      if (classifyCheckoutContext(document.documentElement) === 'unsupported') {
        removePanel();
        sendResponse({ ok: true, status: 'unsupported-context', findingCount: 0 } satisfies AnalyzeResponse);
        return;
      }

      const result = analyzePage();
      let displayResult = result;
      let findingCount = result.findings.length;
      if (request.requestId && request.nonce) {
        const { batch, eligibleFindings } = await buildFindingBatchWithSources(result.findings, request.requestId);
        displayResult = { findings: eligibleFindings };
        findingCount = batch.findings.length;
        const receipt: unknown = await chrome.runtime.sendMessage({ type: CLEARCHOICE_SUBMIT, nonce: request.nonce, batch });
        if (typeof receipt !== 'object' || receipt === null || Object.keys(receipt).length !== 2
          || !('ok' in receipt) || receipt.ok !== true || !('findingCount' in receipt)
          || receipt.findingCount !== batch.findings.length) throw new Error('Batch receipt refused');
      }
      if (!(await getDismissed())) {
        renderPanel(displayResult, () => {
          void setDismissed(true).catch(() => undefined);
        });
      }
      sendResponse({ ok: true, status: 'supported', findingCount } satisfies AnalyzeResponse);
    })().catch(() => {
      sendResponse({ ok: false, error: 'request-failed' } satisfies AnalyzeResponse | RestoreResponse);
    });

    return true;
  });
}
