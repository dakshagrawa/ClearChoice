import { detectPreselectedAddons, detectRecurringCharges } from '../core/detector';
import type { AnalysisResult } from '../core/types';
import { CLEARCHOICE_ANALYZE } from '../shared/messages';
import { getDismissed, setDismissed } from '../shared/storage';
import { renderPanel } from './panel';

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
    sendResponse(result);
  })().catch((error: unknown) => {
    console.error('ClearChoice analysis failed:', error);
    sendResponse({ error: error instanceof Error ? error.message : 'ClearChoice analysis failed.' });
  });

  return true;
});
