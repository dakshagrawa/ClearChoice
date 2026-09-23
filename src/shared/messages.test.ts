import { expect, it } from 'vitest';

import { CLEARCHOICE_ANALYZE, isAnalyzeResponse, isRestoreResponse } from './messages';
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
