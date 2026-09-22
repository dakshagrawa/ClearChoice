import { detectPreselectedAddons, detectRecurringCharges } from '../core/detector';
import type { AnalysisResult, Finding } from '../core/types';
import type {
  AnalyzeResponse,
  ContentRequest,
  RestoreResponse,
} from '../shared/messages';
import { getDismissed, setDismissed } from '../shared/storage';
import { removePanel, renderPanel } from './panel';

const CLEARCHOICE_ANALYZE = 'CLEARCHOICE_ANALYZE' as const;
const CLEARCHOICE_RESTORE = 'CLEARCHOICE_RESTORE' as const;

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
    analyzedAt: new Date().toISOString(),
    pageTitle: document.title,
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const request = message as Partial<ContentRequest>;
  if (request.type !== CLEARCHOICE_ANALYZE && request.type !== CLEARCHOICE_RESTORE) return;

  void (async () => {
    if (request.type === CLEARCHOICE_RESTORE) {
      removePanel();
      await setDismissed(false);
      sendResponse({ ok: true } satisfies RestoreResponse);
      return;
    }

    const result = analyzePage();
    if (!(await getDismissed())) {
      renderPanel(result, () => {
        void setDismissed(true).catch((error: unknown) => console.error('ClearChoice could not save dismissal:', error));
      });
    }
    sendResponse({ ok: true, result } satisfies AnalyzeResponse);
  })().catch((error: unknown) => {
    console.error('ClearChoice message failed:', error);
    const errorMessage = error instanceof Error && error.message !== '' ? error.message : 'ClearChoice request failed.';
    sendResponse({ ok: false, error: errorMessage } satisfies AnalyzeResponse | RestoreResponse);
  });

  return true;
});
