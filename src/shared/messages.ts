import { FINDING_WIRE_VERSION, isFindingDtoBatch, isValidRequestId } from './finding-dto';
import type { FindingDto } from './finding-dto';
import { isGrantOrigin } from './storage';
import { isFindingRecord, isRetentionPolicy, MAX_REVIEW_HISTORY } from './models';
import type { FindingRecord, RetentionPolicy } from './models';

export const CLEARCHOICE_FINDINGS_BATCH = 'CLEARCHOICE_FINDINGS_BATCH' as const;
export const CLEARCHOICE_FINDINGS_CHALLENGE = 'CLEARCHOICE_FINDINGS_CHALLENGE' as const;
export const CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE = 'CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE' as const;
export const CLEARCHOICE_AUTO_STATUS = 'CLEARCHOICE_AUTO_STATUS' as const;
export const CLEARCHOICE_AUTO_START = 'CLEARCHOICE_AUTO_START' as const;
export const CLEARCHOICE_AUTO_SUBMIT = 'CLEARCHOICE_AUTO_SUBMIT' as const;
export const CLEARCHOICE_REVIEW_LIST = 'CLEARCHOICE_REVIEW_LIST' as const;
export const CLEARCHOICE_REVIEW_MARK = 'CLEARCHOICE_REVIEW_MARK' as const;
export const CLEARCHOICE_REVIEW_DELETE = 'CLEARCHOICE_REVIEW_DELETE' as const;
export const CLEARCHOICE_REVIEW_RETENTION = 'CLEARCHOICE_REVIEW_RETENTION' as const;
export const MAX_REVIEW_PAGE = 100;
export const CLEARCHOICE_SUBMIT = 'CLEARCHOICE_SUBMIT' as const;
export const CLEARCHOICE_DISMISSED_GET = 'CLEARCHOICE_DISMISSED_GET' as const;
export const CLEARCHOICE_DISMISSED_SET = 'CLEARCHOICE_DISMISSED_SET' as const;

export interface FindingsBatchRequest {
  type: typeof CLEARCHOICE_FINDINGS_BATCH;
  version: typeof FINDING_WIRE_VERSION;
  requestId: string;
  findings: FindingDto[];
}

export interface FindingsChallenge {
  type: typeof CLEARCHOICE_FINDINGS_CHALLENGE;
  version: typeof FINDING_WIRE_VERSION;
  requestId: string;
  nonce: string;
}

export interface AutomaticObservation {
  type: typeof CLEARCHOICE_AUTO_SUBMIT;
  version: typeof FINDING_WIRE_VERSION;
  generation: number;
  batch: FindingsBatchRequest;
}

export function isAutomaticObservation(value: unknown): value is AutomaticObservation {
  return isRecord(value) && hasExactKeys(value, ['type', 'version', 'generation', 'batch'])
    && value.type === CLEARCHOICE_AUTO_SUBMIT && value.version === FINDING_WIRE_VERSION
    && Number.isSafeInteger(value.generation) && (value.generation as number) > 0
    && isFindingsBatchRequest(value.batch);
}

export function isFindingsChallengeResponse(value: unknown): value is { type: typeof CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE; version: 1; requestId: string; nonce: string } {
  return isRecord(value) && hasExactKeys(value, ['type', 'version', 'requestId', 'nonce'])
    && value.type === CLEARCHOICE_FINDINGS_CHALLENGE_RESPONSE && value.version === 1
    && isValidRequestId(value.requestId) && isValidRequestId(value.nonce);
}

export interface ReviewListResponse {
  type: typeof CLEARCHOICE_REVIEW_LIST;
  version: typeof FINDING_WIRE_VERSION;
  offset: number;
  total: number;
  needsReviewCount: number;
  retentionPolicy: RetentionPolicy;
  findings: ReviewItem[];
}

export type ReviewItem = Pick<FindingRecord, 'id' | 'origin' | 'kind' | 'reason' | 'screenedExcerpt' | 'firstSeen' | 'latestSeen' | 'status'>;
const reviewId = /^f_[a-f0-9]{64}$/;
const boundedOffset = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_REVIEW_HISTORY;
const pageLimit = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REVIEW_PAGE;

function isReviewItem(value: unknown): value is ReviewItem {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'origin', 'kind', 'reason', 'screenedExcerpt', 'firstSeen', 'latestSeen', 'status'])) return false;
  return isFindingRecord({ ...value, opaqueFingerprint: 'a'.repeat(64), ordinal: 1 });
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isFindingsBatchRequest(value: unknown): value is FindingsBatchRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'version', 'requestId', 'findings'])) return false;
  return value.type === CLEARCHOICE_FINDINGS_BATCH && value.version === FINDING_WIRE_VERSION
    && isValidRequestId(value.requestId) && isFindingDtoBatch(value.findings)
    && value.findings.every((finding) => finding.requestId === value.requestId);
}

export function isFindingsChallenge(value: unknown): value is FindingsChallenge {
  return isRecord(value) && hasExactKeys(value, ['type', 'version', 'requestId', 'nonce'])
    && value.type === CLEARCHOICE_FINDINGS_CHALLENGE && value.version === FINDING_WIRE_VERSION
    && isValidRequestId(value.requestId) && isValidRequestId(value.nonce);
}

export function isReviewListResponse(value: unknown): value is ReviewListResponse {
  return isRecord(value) && hasExactKeys(value, ['type', 'version', 'offset', 'total', 'needsReviewCount', 'retentionPolicy', 'findings'])
    && value.type === CLEARCHOICE_REVIEW_LIST && value.version === FINDING_WIRE_VERSION
    && boundedOffset(value.offset) && boundedOffset(value.total) && boundedOffset(value.needsReviewCount)
    && (value.needsReviewCount as number) <= (value.total as number) && isRetentionPolicy(value.retentionPolicy)
    && Array.isArray(value.findings) && value.findings.length <= MAX_REVIEW_PAGE
    && value.findings.length <= Math.max(0, (value.total as number) - (value.offset as number))
    && value.findings.every(isReviewItem)
    && new Set(value.findings.map((item: ReviewItem) => item.id)).size === value.findings.length;
}

export const CLEARCHOICE_ANALYZE = 'CLEARCHOICE_ANALYZE' as const;
export const CLEARCHOICE_RESTORE = 'CLEARCHOICE_RESTORE' as const;
export const CLEARCHOICE_DISABLE = 'CLEARCHOICE_DISABLE' as const;
export const CLEARCHOICE_SITE_STATUS = 'CLEARCHOICE_SITE_STATUS' as const;
export const CLEARCHOICE_SITE_ENABLE = 'CLEARCHOICE_SITE_ENABLE' as const;
export const CLEARCHOICE_SITE_REVOKE = 'CLEARCHOICE_SITE_REVOKE' as const;
export type SiteResponse = { ok: true; enabled: boolean; permitted: boolean }
  | { ok: false; error: 'request-failed' | 'revocation-unsafe' };

export function isSiteResponse(value: unknown): value is SiteResponse {
  if (!isRecord(value)) return false;
  return (hasExactKeys(value, ['ok', 'enabled', 'permitted']) && value.ok === true
    && typeof value.enabled === 'boolean' && typeof value.permitted === 'boolean')
    || (hasExactKeys(value, ['ok', 'error']) && value.ok === false
      && (value.error === 'request-failed' || value.error === 'revocation-unsafe'));
}

export interface AnalyzeRequest {
  type: typeof CLEARCHOICE_ANALYZE;
  requestId?: string;
  nonce?: string;
}

export interface RestoreRequest {
  type: typeof CLEARCHOICE_RESTORE;
}

export type ContentRequest = AnalyzeRequest | RestoreRequest | FindingsChallenge | { type: typeof CLEARCHOICE_DISABLE } | { type: typeof CLEARCHOICE_AUTO_START; version: 1; generation: number };
export type AnalyzeResponse =
  | { ok: true; status: 'supported'; findingCount: number }
  | { ok: true; status: 'unsupported-context'; findingCount: 0 }
  | { ok: false; error: 'restricted-page' | 'injection-failed' | 'request-failed' };
export type RestoreResponse = { ok: true } | { ok: false; error: 'request-failed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isContentRequest(value: unknown): value is ContentRequest {
  return isFindingsChallenge(value) || (isRecord(value)
    && ((hasExactKeys(value, ['type']) && (value.type === CLEARCHOICE_ANALYZE || value.type === CLEARCHOICE_RESTORE || value.type === CLEARCHOICE_DISABLE))
      || (hasExactKeys(value, ['type', 'version', 'generation']) && value.type === CLEARCHOICE_AUTO_START
        && value.version === 1 && Number.isSafeInteger(value.generation) && (value.generation as number) > 0)
      || (hasExactKeys(value, ['type', 'requestId', 'nonce']) && value.type === CLEARCHOICE_ANALYZE
        && isValidRequestId(value.requestId) && isValidRequestId(value.nonce))));
}

export function isWorkerRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isAutomaticObservation(value)) return true;
  if (hasExactKeys(value, ['type', 'version', 'offset', 'limit']) && value.type === CLEARCHOICE_REVIEW_LIST)
    return value.version === 1 && boundedOffset(value.offset) && pageLimit(value.limit);
  if (hasExactKeys(value, ['type', 'version', 'id']) && (value.type === CLEARCHOICE_REVIEW_MARK || value.type === CLEARCHOICE_REVIEW_DELETE))
    return value.version === 1 && typeof value.id === 'string' && reviewId.test(value.id);
  if (hasExactKeys(value, ['type', 'version', 'policy']) && value.type === CLEARCHOICE_REVIEW_RETENTION)
    return value.version === 1 && isRetentionPolicy(value.policy);
  return (hasExactKeys(value, ['type']) && (value.type === CLEARCHOICE_AUTO_STATUS || value.type === CLEARCHOICE_ANALYZE || value.type === CLEARCHOICE_RESTORE || value.type === CLEARCHOICE_DISMISSED_GET))
    || (hasExactKeys(value, ['type', 'origin']) && isGrantOrigin(value.origin)
      && (value.type === CLEARCHOICE_SITE_STATUS || value.type === CLEARCHOICE_SITE_ENABLE || value.type === CLEARCHOICE_SITE_REVOKE))
    || (hasExactKeys(value, ['type', 'dismissed']) && value.type === CLEARCHOICE_DISMISSED_SET && typeof value.dismissed === 'boolean')
    || (hasExactKeys(value, ['type', 'nonce', 'batch']) && value.type === CLEARCHOICE_SUBMIT
      && isValidRequestId(value.nonce) && isFindingsBatchRequest(value.batch));
}

export function isAnalyzeResponse(value: unknown): value is AnalyzeResponse {
  if (!isRecord(value)) return false;
  if (value.ok === false) {
    return Object.keys(value).length === 2
      && (value.error === 'restricted-page' || value.error === 'injection-failed' || value.error === 'request-failed');
  }
  if (value.ok !== true || Object.keys(value).length !== 3) return false;
  return (value.status === 'supported' && typeof value.findingCount === 'number' && Number.isInteger(value.findingCount) && value.findingCount >= 0)
    || (value.status === 'unsupported-context' && value.findingCount === 0);
}

export function isRestoreResponse(value: unknown): value is RestoreResponse {
  return isRecord(value)
    && ((value.ok === true && Object.keys(value).length === 1)
      || (value.ok === false && value.error === 'request-failed' && Object.keys(value).length === 2));
}
