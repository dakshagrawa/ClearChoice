import { expect, it } from 'vitest';

import { CLEARCHOICE_ANALYZE, CLEARCHOICE_RESTORE, isAnalyzeResponse, isContentRequest, isRestoreResponse } from './messages';
import type { AnalyzeRequest, AnalyzeResponse, RestoreResponse } from './messages';

it('defines popup-safe successful analysis messages with status and count only', () => {
  const request: AnalyzeRequest = { type: CLEARCHOICE_ANALYZE };
  const response: AnalyzeResponse = { ok: true, status: 'supported', findingCount: 1 };

  expect(request.type).toBe('CLEARCHOICE_ANALYZE');
  expect(isAnalyzeResponse(response)).toBe(true);
  expect(Object.keys(response)).toEqual(['ok', 'status', 'findingCount']);
});

it('accepts the zero-count unsupported context response and rejects page data', () => {
  expect(isAnalyzeResponse({ ok: true, status: 'unsupported-context', findingCount: 0 })).toBe(true);
  expect(isAnalyzeResponse({ ok: true, status: 'unsupported-context', findingCount: 1 })).toBe(false);
  expect(isAnalyzeResponse({ ok: true, status: 'supported', findingCount: 1, pageTitle: 'private' })).toBe(false);
});

it('accepts only exact inbound Analyze and Restore requests', () => {
  expect(isContentRequest({ type: CLEARCHOICE_ANALYZE })).toBe(true);
  expect(isContentRequest({ type: CLEARCHOICE_RESTORE })).toBe(true);
  expect(isContentRequest({ type: CLEARCHOICE_ANALYZE, pageTitle: 'private' })).toBe(false);
  expect(isContentRequest({ type: CLEARCHOICE_RESTORE, checkoutHtml: '<form>' })).toBe(false);
  expect(isContentRequest({ type: 'OTHER_MESSAGE' })).toBe(false);
  expect(isContentRequest(null)).toBe(false);
});

it('defines a closed typed failure union', () => {
  const response: AnalyzeResponse = { ok: false, error: 'injection-failed' };
  expect(isAnalyzeResponse(response)).toBe(true);
  expect(isAnalyzeResponse({ ok: false, error: 'unexpected-error' })).toBe(false);
});

it('accepts only exact restore response shapes and rejects page data', () => {
  const success: RestoreResponse = { ok: true };
  const failure: RestoreResponse = { ok: false, error: 'request-failed' };

  expect(isRestoreResponse(success)).toBe(true);
  expect(isRestoreResponse(failure)).toBe(true);
  expect(isRestoreResponse({ ok: true, pageTitle: 'private' })).toBe(false);
  expect(isRestoreResponse({ ok: false, error: 'request-failed', checkoutHtml: '<form>' })).toBe(false);
});
