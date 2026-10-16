import { resolveCancellationGuide } from './guide-catalog';
import type { CancellationGuideResolution } from './guide-catalog';
import { FINDING_WIRE_VERSION, isFindingDtoBatch, isValidRequestId } from './finding-dto';
import type { FindingDto } from './finding-dto';
import { isGrantOrigin } from './storage';
import { isFindingRecord, isRecordIdentifier, isRetentionPolicy, MAX_REVIEW_HISTORY } from './models';
import type { FindingRecord, RetentionPolicy } from './models';

import { isSubscriptionFields, isSubscriptionCollection, isSubscription } from './models';

export type SubscriptionMutationResponse =
  | { type: typeof CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING | typeof CLEARCHOICE_SUBSCRIPTION_CREATE | typeof CLEARCHOICE_SUBSCRIPTION_UPDATE; version: 1; subscription: import('./models').Subscription }
  | { type: typeof CLEARCHOICE_SUBSCRIPTION_DELETE; version: 1; id: string };

export function isSubscriptionMutationResponse(value: unknown): value is SubscriptionMutationResponse {
  return isRecord(value) && value.version === 1
    && ((hasExactKeys(value, ['type', 'version', 'subscription'])
      && (value.type === CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING || value.type === CLEARCHOICE_SUBSCRIPTION_CREATE || value.type === CLEARCHOICE_SUBSCRIPTION_UPDATE) && isSubscription(value.subscription)
      && (value.type !== CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING || isRecordIdentifier(value.subscription.sourceFindingId)))
      || (hasExactKeys(value, ['type', 'version', 'id']) && value.type === CLEARCHOICE_SUBSCRIPTION_DELETE && isRecordIdentifier(value.id)));
}

export const CLEARCHOICE_SUBSCRIPTION_HELP = 'CLEARCHOICE_SUBSCRIPTION_HELP' as const;
export type SubscriptionHelpResponse = { type: typeof CLEARCHOICE_SUBSCRIPTION_HELP; version: 1; id: string; help: CancellationGuideResolution };

/** Reconstruct metadata from the local allowlist; never trust an arbitrary destination. */
export function isSubscriptionHelpResponse(value: unknown): value is SubscriptionHelpResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'version', 'id', 'help'])
    || value.type !== CLEARCHOICE_SUBSCRIPTION_HELP || value.version !== 1 || !isRecordIdentifier(value.id)
    || !isRecord(value.help)) return false;
  const help = value.help;
  const expected = help.kind === 'guide'
    ? [resolveCancellationGuide('https://netflix.com'), resolveCancellationGuide('https://spotify.com')]
    : [resolveCancellationGuide(help.kind === 'site' ? help.originURL : undefined)];
  return expected.some((entry) => entry.kind === help.kind
    && hasExactKeys(help, Object.keys(entry))
    && Object.entries(entry).every(([key, item]) => help[key] === item));
}

export const CLEARCHOICE_SUBSCRIPTION_LIST = 'CLEARCHOICE_SUBSCRIPTION_LIST' as const;
export const CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING = 'CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING' as const;
export const CLEARCHOICE_SUBSCRIPTION_CREATE = 'CLEARCHOICE_SUBSCRIPTION_CREATE' as const;
export const CLEARCHOICE_SUBSCRIPTION_UPDATE = 'CLEARCHOICE_SUBSCRIPTION_UPDATE' as const;
export const CLEARCHOICE_SUBSCRIPTION_DELETE = 'CLEARCHOICE_SUBSCRIPTION_DELETE' as const;

export function isSubscriptionListResponse(value: unknown): value is { type: typeof CLEARCHOICE_SUBSCRIPTION_LIST; version: 1; subscriptions: import('./models').Subscription[] } {
  return isRecord(value) && hasExactKeys(value, ['type', 'version', 'subscriptions'])
    && value.type === CLEARCHOICE_SUBSCRIPTION_LIST && value.version === 1 && isSubscriptionCollection(value.subscriptions);
}

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

export const CLEARCHOICE_AUTO_DOCUMENT_STATUS = 'CLEARCHOICE_AUTO_DOCUMENT_STATUS' as const;
export interface AutomaticDocumentStatus {
  type: typeof CLEARCHOICE_AUTO_DOCUMENT_STATUS;
  version: 1;
  generation: number;
  requestId: string;
  status: 'supported-zero' | 'unsupported-context' | 'unavailable-overflow';
}
export function isAutomaticDocumentStatus(value: unknown): value is AutomaticDocumentStatus {
  return isRecord(value) && hasExactKeys(value, ['type', 'version', 'generation', 'requestId', 'status'])
    && value.type === CLEARCHOICE_AUTO_DOCUMENT_STATUS && value.version === 1
    && Number.isSafeInteger(value.generation) && (value.generation as number) > 0
    && isValidRequestId(value.requestId)
    && (value.status === 'supported-zero' || value.status === 'unsupported-context' || value.status === 'unavailable-overflow');
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
export const CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION = 'CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION' as const;
export const CLEARCHOICE_SITE_ENABLE = 'CLEARCHOICE_SITE_ENABLE' as const;
export const CLEARCHOICE_SITE_REVOKE = 'CLEARCHOICE_SITE_REVOKE' as const;
export type SiteResponse = { ok: true; enabled: boolean; permitted: boolean }
  | { ok: false; error: 'request-failed' | 'revocation-unsafe' | 'permission-denied' | 'operation-expired' };

export function isSiteResponse(value: unknown): value is SiteResponse {
  if (!isRecord(value)) return false;
  return (hasExactKeys(value, ['ok', 'enabled', 'permitted']) && value.ok === true
    && typeof value.enabled === 'boolean' && typeof value.permitted === 'boolean')
    || (hasExactKeys(value, ['ok', 'error']) && value.ok === false
      && (value.error === 'request-failed' || value.error === 'revocation-unsafe' || value.error === 'permission-denied' || value.error === 'operation-expired'));
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
  if (hasExactKeys(value, ['type', 'origin', 'tabId']) && value.type === CLEARCHOICE_SITE_ENABLE_WITH_PERMISSION)
    return isGrantOrigin(value.origin) && Number.isSafeInteger(value.tabId) && (value.tabId as number) >= 0;
  if (hasExactKeys(value, ['type', 'version']) && value.type === CLEARCHOICE_SUBSCRIPTION_LIST) return value.version === 1;
  if (hasExactKeys(value, ['type', 'version', 'fields']) && value.type === CLEARCHOICE_SUBSCRIPTION_CREATE)
    return value.version === 1 && isSubscriptionFields(value.fields);
  if (hasExactKeys(value, ['type', 'version', 'id', 'fields']) && (value.type === CLEARCHOICE_SUBSCRIPTION_UPDATE || value.type === CLEARCHOICE_SUBSCRIPTION_CONFIRM_FINDING))
    return value.version === 1 && isRecordIdentifier(value.id) && isSubscriptionFields(value.fields);
  if (hasExactKeys(value, ['type', 'version', 'id']) && (value.type === CLEARCHOICE_SUBSCRIPTION_DELETE || value.type === CLEARCHOICE_SUBSCRIPTION_HELP))
    return value.version === 1 && isRecordIdentifier(value.id);
  if (isAutomaticObservation(value) || isAutomaticDocumentStatus(value)) return true;
  if (hasExactKeys(value, ['type', 'version', 'offset', 'limit']) && value.type === CLEARCHOICE_REVIEW_LIST)
    return value.version === 1 && boundedOffset(value.offset) && pageLimit(value.limit);
  if (hasExactKeys(value, ['type', 'version', 'id']) && (value.type === CLEARCHOICE_REVIEW_MARK || value.type === CLEARCHOICE_REVIEW_DELETE))
    return value.version === 1 && isRecordIdentifier(value.id);
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
