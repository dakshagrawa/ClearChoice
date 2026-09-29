import { expect, it } from 'vitest';

import { CLEARCHOICE_ANALYZE, CLEARCHOICE_RESTORE, isAnalyzeResponse, isContentRequest, isRestoreResponse, isFindingsBatchRequest, isFindingsChallenge, isReviewListResponse, isWorkerRequest, isSiteResponse } from './messages';
import { toFindingDto } from './finding-dto';
import type { Finding } from '../core/types';
import type { AnalyzeRequest, AnalyzeResponse, RestoreResponse } from './messages';
import { isFindingsChallengeResponse } from './messages';

it('accepts only the exact generation-bootstrap request shape', () => {
  expect(isWorkerRequest({ type: 'CLEARCHOICE_AUTO_STATUS' })).toBe(true);
  expect(isWorkerRequest({ type: 'CLEARCHOICE_AUTO_STATUS', origin: 'https://merchant.test' })).toBe(false);
});

it('accepts only exact automatic observation and challenge response shapes', () => {
  const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: 'scan-1', findings: [] };
  const observation = { type: 'CLEARCHOICE_AUTO_SUBMIT', version: 1, generation: 1, batch };
  const reply = { type: 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE', version: 1, requestId: 'scan-1', nonce: 'opaque-1' };
  expect(isWorkerRequest(observation)).toBe(true);
  expect(isWorkerRequest({ ...observation, url: '/checkout' })).toBe(false);
  expect(isWorkerRequest({ ...observation, generation: 0 })).toBe(false);
  expect(isWorkerRequest({ ...observation, batch: { ...batch, findings: [{ evidence: 'raw' }] } })).toBe(false);
  expect(isFindingsChallengeResponse(reply)).toBe(true);
  expect(isFindingsChallengeResponse({ ...reply, selector: '#private' })).toBe(false);
  expect(isContentRequest({ type: 'CLEARCHOICE_FINDINGS_CHALLENGE', version: 1, requestId: 'scan-1', nonce: 'opaque-1' })).toBe(true);
});

it('requires exact worker control, dismissal, and challenged batch shapes', () => {
  expect(isWorkerRequest({ type: 'CLEARCHOICE_ANALYZE' })).toBe(true);
  expect(isWorkerRequest({ type: 'CLEARCHOICE_DISMISSED_GET' })).toBe(true);
  expect(isWorkerRequest({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: true })).toBe(true);
  expect(isWorkerRequest({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: 'true' })).toBe(false);
  expect(isWorkerRequest({ type: 'CLEARCHOICE_DISMISSED_SET', dismissed: true, evidence: 'private' })).toBe(false);
  expect(isContentRequest({ type: 'CLEARCHOICE_ANALYZE', requestId: 'req1', nonce: 'nonce1' })).toBe(true);
  expect(isContentRequest({ type: 'CLEARCHOICE_ANALYZE', requestId: 'req1', nonce: 'nonce1', url: 'private' })).toBe(false);
  expect(isWorkerRequest({ type: 'CLEARCHOICE_SUBMIT', nonce: 'nonce1', batch: { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: 'req1', findings: [] } })).toBe(true);
  expect(isWorkerRequest({ type: 'CLEARCHOICE_SUBMIT', nonce: 'nonce1', batch: { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: 'req1', findings: [] }, selector: '#private' })).toBe(false);
});

it('accepts only canonical HTTPS origin site controls and exact site responses', () => {
  for (const type of ['CLEARCHOICE_SITE_STATUS', 'CLEARCHOICE_SITE_ENABLE', 'CLEARCHOICE_SITE_REVOKE']) {
    expect(isWorkerRequest({ type, origin: 'https://a.test' })).toBe(true);
    for (const origin of ['http://a.test', 'https://a.test/path', 'https://a.test/', 'https://a.test?x=1'])
      expect(isWorkerRequest({ type, origin })).toBe(false);
    expect(isWorkerRequest({ type, origin: 'https://a.test', pageTitle: 'private' })).toBe(false);
  }
  expect(isWorkerRequest({ type: 'CLEARCHOICE_SITE_ENABLE' })).toBe(false);
  expect(isSiteResponse({ ok: true, enabled: true, permitted: true })).toBe(true);
  expect(isSiteResponse({ ok: true, enabled: false, permitted: false, url: '/checkout' })).toBe(false);
  expect(isSiteResponse({ ok: false, error: 'revocation-unsafe' })).toBe(true);
});

it('accepts only the exact disable control shape in content, not worker requests', () => {
  expect(isContentRequest({ type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 5 })).toBe(true);
  expect(isContentRequest({ type: 'CLEARCHOICE_AUTO_START' })).toBe(false);
  expect(isContentRequest({ type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 5, extra: true })).toBe(false);
  expect(isContentRequest({ type: 'CLEARCHOICE_AUTO_START', version: 1, generation: 0 })).toBe(false);
  expect(isContentRequest({ type: 'CLEARCHOICE_DISABLE' })).toBe(true);
  expect(isContentRequest({ type: 'CLEARCHOICE_DISABLE', origin: 'https://a.test' })).toBe(false);
  expect(isWorkerRequest({ type: 'CLEARCHOICE_DISABLE' })).toBe(false);
});

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

const raw: Finding = {
  id: 'private-id', kind: 'recurring-charge', reason: 'price-cadence', severity: 'notice',
  title: 'Page title', explanation: 'explanation', evidence: '$10 per month', selector: '#private',
};
const dto = toFindingDto(raw, 'req-1', 1, 'a'.repeat(64))!;

it('validates a versioned exact-key batch without allowing page data in serialized transport', () => {
  const batch = { type: 'CLEARCHOICE_FINDINGS_BATCH', version: 1, requestId: 'req-1', findings: [dto] };
  expect(isFindingsBatchRequest(batch)).toBe(true);
  expect(isContentRequest(batch)).toBe(false);
  for (const forbidden of ['selector', 'evidence', 'url', 'pageTitle', 'formValue', '#private', 'private-id']) {
    expect(JSON.stringify(batch)).not.toContain(forbidden);
  }
  for (const extra of [{ selector: '#x' }, { url: 'https://example.test/path' }, { evidence: 'raw' }, { pageTitle: 'private' }, { formValue: 'private' }, { version: 2 }, { requestId: 'req-2' }]) {
    expect(isFindingsBatchRequest({ ...batch, ...extra })).toBe(false);
  }
  expect(isFindingsBatchRequest({ ...batch, findings: [{ ...dto, evidence: 'raw' }] })).toBe(false);
  expect(isFindingsBatchRequest({ ...batch, findings: [{ ...dto, requestId: 'req-2' }] })).toBe(false);
  expect(isFindingsBatchRequest({ ...batch, findings: Array.from({ length: 101 }, () => dto) })).toBe(false);
});

it('validates challenge and list response separately from the manual count response', () => {
  const challenge = { type: 'CLEARCHOICE_FINDINGS_CHALLENGE', version: 1, requestId: 'req-1', nonce: 'opaque-1' };
  const list = { type: 'CLEARCHOICE_REVIEW_LIST', version: 1, findings: [dto] };
  expect(isFindingsChallenge(challenge)).toBe(true);
  expect(isReviewListResponse(list)).toBe(true);
  expect(isAnalyzeResponse(list)).toBe(false);
  expect(isAnalyzeResponse({ ok: true, status: 'supported', findingCount: 1, findings: [dto] })).toBe(false);
  expect(isFindingsChallenge({ ...challenge, nonce: 'https://example.test/path' })).toBe(false);
  expect(isFindingsChallenge({ ...challenge, selector: '#private' })).toBe(false);
  expect(isReviewListResponse({ ...list, pageTitle: 'private' })).toBe(false);
});
