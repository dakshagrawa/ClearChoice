import { FINDING_WIRE_VERSION, isFindingDtoBatch, isValidRequestId } from './finding-dto';
import type { FindingDto } from './finding-dto';

export const CLEARCHOICE_FINDINGS_BATCH = 'CLEARCHOICE_FINDINGS_BATCH' as const;
export const CLEARCHOICE_FINDINGS_CHALLENGE = 'CLEARCHOICE_FINDINGS_CHALLENGE' as const;
export const CLEARCHOICE_REVIEW_LIST = 'CLEARCHOICE_REVIEW_LIST' as const;
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

export interface ReviewListResponse {
  type: typeof CLEARCHOICE_REVIEW_LIST;
  version: typeof FINDING_WIRE_VERSION;
  findings: FindingDto[];
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
  return isRecord(value) && hasExactKeys(value, ['type', 'version', 'findings'])
    && value.type === CLEARCHOICE_REVIEW_LIST && value.version === FINDING_WIRE_VERSION
    && isFindingDtoBatch(value.findings);
}

export const CLEARCHOICE_ANALYZE = 'CLEARCHOICE_ANALYZE' as const;
export const CLEARCHOICE_RESTORE = 'CLEARCHOICE_RESTORE' as const;

export interface AnalyzeRequest {
  type: typeof CLEARCHOICE_ANALYZE;
  requestId?: string;
  nonce?: string;
}

export interface RestoreRequest {
  type: typeof CLEARCHOICE_RESTORE;
}

export type ContentRequest = AnalyzeRequest | RestoreRequest;
export type AnalyzeResponse =
  | { ok: true; status: 'supported'; findingCount: number }
  | { ok: true; status: 'unsupported-context'; findingCount: 0 }
  | { ok: false; error: 'restricted-page' | 'injection-failed' | 'request-failed' };
export type RestoreResponse = { ok: true } | { ok: false; error: 'request-failed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isContentRequest(value: unknown): value is ContentRequest {
  return isRecord(value)
    && ((hasExactKeys(value, ['type']) && (value.type === CLEARCHOICE_ANALYZE || value.type === CLEARCHOICE_RESTORE))
      || (hasExactKeys(value, ['type', 'requestId', 'nonce']) && value.type === CLEARCHOICE_ANALYZE
        && isValidRequestId(value.requestId) && isValidRequestId(value.nonce)));
}

export function isWorkerRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (hasExactKeys(value, ['type']) && (value.type === CLEARCHOICE_ANALYZE || value.type === CLEARCHOICE_RESTORE || value.type === CLEARCHOICE_DISMISSED_GET))
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
