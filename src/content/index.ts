import { detectPreselectedAddons, detectRecurringCharges } from '../core/detector';
import type { AnalysisResult, Finding } from '../core/types';
import type {
  AnalyzeResponse,
  ContentRequest,
  RestoreResponse,
} from '../shared/messages';
import { getDismissed, setDismissed } from '../shared/storage';
import { removePanel, renderPanel } from './panel';

const contentSentinel = '__clearchoiceContentListenerInstalled__';
const CLEARCHOICE_ANALYZE = 'CLEARCHOICE_ANALYZE' as const;
const CLEARCHOICE_RESTORE = 'CLEARCHOICE_RESTORE' as const;

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
          void setDismissed(true).catch(() => undefined);
        });
      }
      sendResponse({ ok: true, status: 'supported', findingCount: result.findings.length } satisfies AnalyzeResponse);
    })().catch(() => {
      sendResponse({ ok: false, error: 'request-failed' } satisfies AnalyzeResponse | RestoreResponse);
    });

    return true;
  });
}
