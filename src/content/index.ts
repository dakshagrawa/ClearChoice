import { classifyCheckoutContext } from '../core/context';
import { detectPreselectedAddons, detectRecurringCharges } from '../core/detector';
import type { AnalysisResult, Finding } from '../core/types';
import {
  CLEARCHOICE_DISMISSED_GET,
  CLEARCHOICE_DISABLE,
  CLEARCHOICE_DISMISSED_SET,
  CLEARCHOICE_RESTORE,
  CLEARCHOICE_SUBMIT,
  isContentRequest,
} from '../shared/messages';
import type {
  AnalyzeResponse,
  RestoreResponse,
} from '../shared/messages';
import { buildFindingBatchWithSources } from './candidates';
import { removePanel, renderPanel } from './panel';

const contentSentinel = '__clearchoiceContentListenerInstalled__';

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

const pageWindow = window as ClearChoiceWindow;
if (!pageWindow[contentSentinel]) {
  pageWindow[contentSentinel] = true;

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isContentRequest(message)) return;
    const request = message;

    void (async () => {
      if (request.type === CLEARCHOICE_DISABLE) {
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
