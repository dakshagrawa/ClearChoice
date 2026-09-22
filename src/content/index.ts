import { detectPreselectedAddons, detectRecurringCharges } from '../core/detector';
import type { AnalysisResult } from '../core/types';
import type { AnalyzeResponse } from '../shared/messages';
import { getDismissed, setDismissed } from '../shared/storage';
import { renderPanel } from './panel';

const CLEARCHOICE_ANALYZE = 'CLEARCHOICE_ANALYZE' as const;

function analyzePage(): AnalysisResult {
  return {
    findings: [
      ...detectRecurringCharges(document.documentElement),
      ...detectPreselectedAddons(document.documentElement),
    ],
    analyzedAt: new Date().toISOString(),
    pageTitle: document.title,
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== CLEARCHOICE_ANALYZE) {
    return;
  }

  void (async () => {
    const result = analyzePage();
    if (!(await getDismissed())) {
      renderPanel(result, () => {
        void setDismissed(true).catch((error: unknown) => console.error('ClearChoice could not save dismissal:', error));
      });
    }
    sendResponse({ ok: true, result } satisfies AnalyzeResponse);
  })().catch((error: unknown) => {
    console.error('ClearChoice analysis failed:', error);
    const message = error instanceof Error && error.message !== '' ? error.message : 'ClearChoice analysis failed.';
    sendResponse({ ok: false, error: message } satisfies AnalyzeResponse);
  });

  return true;
});
