import {
  CLEARCHOICE_ANALYZE,
  CLEARCHOICE_RESTORE,
  isAnalyzeResponse,
  isRestoreResponse,
} from './messages';
import type { AnalyzeResponse, RestoreResponse } from './messages';

const restrictedInjectionPatterns = [
  /cannot access contents of url/i,
  /cannot access a chrome:/i,
  /extensions gallery/i,
  /chrome\.google\.com\/webstore/i,
  /cannot access a pdf/i,
  /cannot script.*extension/i,
];

function isRestrictedInjectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return restrictedInjectionPatterns.some((pattern) => pattern.test(message));
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function injectContentScript(tabId: number): Promise<'ok' | AnalyzeResponse> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return 'ok';
  } catch (error: unknown) {
    return { ok: false, error: isRestrictedInjectionError(error) ? 'restricted-page' : 'injection-failed' };
  }
}

export async function analyzeActiveTab(): Promise<AnalyzeResponse> {
  try {
    const tabId = await activeTabId();
    if (tabId === undefined) return { ok: false, error: 'request-failed' };

    const injected = await injectContentScript(tabId);
    if (injected !== 'ok') return injected;

    const response = await chrome.tabs.sendMessage(tabId, { type: CLEARCHOICE_ANALYZE });
    return isAnalyzeResponse(response) ? response : { ok: false, error: 'request-failed' };
  } catch {
    return { ok: false, error: 'request-failed' };
  }
}

export async function restoreActiveTab(): Promise<RestoreResponse> {
  try {
    const tabId = await activeTabId();
    if (tabId === undefined) return { ok: false, error: 'request-failed' };

    const injected = await injectContentScript(tabId);
    if (injected !== 'ok') return { ok: false, error: 'request-failed' };

    const response = await chrome.tabs.sendMessage(tabId, { type: CLEARCHOICE_RESTORE });
    return isRestoreResponse(response) ? response : { ok: false, error: 'request-failed' };
  } catch {
    return { ok: false, error: 'request-failed' };
  }
}
