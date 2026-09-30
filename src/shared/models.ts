import { normalizeVisibleText } from '../core/normalize';
import { hasSensitiveDisplayData } from '../core/sensitive';
import { hasUnsafeUrlText, isFindingDto, isValidFindingPair, MAX_ORDINAL } from './finding-dto';
import type { FindingKind, FindingReason } from '../core/types';

export const MAX_REVIEW_HISTORY = 500;
export const MAX_SUBSCRIPTIONS = 500;
export type RetentionPolicy = 7 | 30 | 90 | 'never';
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = 30;

export function isRetentionPolicy(value: unknown): value is RetentionPolicy {
  return value === 7 || value === 30 || value === 90 || value === 'never';
}

export interface Subscription {
  id: string;
  merchant: string;
  amount: string;
  currency: string;
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom';
  customDescription?: string;
  nextBillingDate?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  sourceFindingId?: string;
}

export interface FindingRecord {
  id: string;
  origin: string;
  kind: FindingKind;
  reason: FindingReason;
  screenedExcerpt: string;
  opaqueFingerprint: string;
  ordinal: number;
  firstSeen: string;
  latestSeen: string;
  status: 'needs-review' | 'reviewed';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AMOUNT = /^(?:0|[1-9]\d{0,8})\.\d{2}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const currencyCodes = new Set(Intl.supportedValuesOf('currency'));

export function isRecordIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}
const identifier = isRecordIdentifier;

function instant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function date(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// Static text only: never retain URL/path/query or payment/account displays in user-owned fields.
function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && normalizeVisibleText(value) === value && !hasSensitiveDisplayData(value)
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    && !hasUnsafeUrlText(value);
}

export function normalizeMerchant(value: string): string {
  return normalizeVisibleText(value).trim();
}

export function normalizeCurrency(value: string): string {
  return value.toUpperCase();
}

export function isSubscription(value: unknown): value is Subscription {
  if (!record(value) || !exact(value,
    ['id', 'merchant', 'amount', 'currency', 'cadence', 'createdAt', 'updatedAt'],
    ['customDescription', 'nextBillingDate', 'notes', 'sourceFindingId'])) return false;
  return identifier(value.id) && safeText(value.merchant, 120)
    && typeof value.amount === 'string' && AMOUNT.test(value.amount) && value.amount !== '0.00'
    && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) && currencyCodes.has(value.currency)
    && (value.cadence === 'weekly' || value.cadence === 'monthly' || value.cadence === 'quarterly'
      || value.cadence === 'yearly' || value.cadence === 'custom')
    && (value.cadence === 'custom' ? safeText(value.customDescription, 120) : !Object.hasOwn(value, 'customDescription'))
    && (!Object.hasOwn(value, 'nextBillingDate') || date(value.nextBillingDate))
    && (!Object.hasOwn(value, 'notes') || safeText(value.notes, 500))
    && (!Object.hasOwn(value, 'sourceFindingId') || identifier(value.sourceFindingId))
    && instant(value.createdAt) && instant(value.updatedAt) && value.updatedAt >= value.createdAt;
}

export function isFindingRecord(value: unknown): value is FindingRecord {
  if (!record(value) || !exact(value, [
    'id', 'origin', 'kind', 'reason', 'screenedExcerpt', 'opaqueFingerprint',
    'ordinal', 'firstSeen', 'latestSeen', 'status',
  ])) return false;
  if (!identifier(value.id) || !canonicalOrigin(value.origin)) return false;
  return isFindingDto({
    version: 1, requestId: 'persisted', kind: value.kind, reason: value.reason,
    screenedExcerpt: value.screenedExcerpt, opaqueFingerprint: value.opaqueFingerprint,
    ordinal: value.ordinal,
  }) && isValidFindingPair(value.kind, value.reason)
    && typeof value.ordinal === 'number' && value.ordinal <= MAX_ORDINAL
    && instant(value.firstSeen) && instant(value.latestSeen) && value.latestSeen >= value.firstSeen
    && (value.status === 'needs-review' || value.status === 'reviewed');
}

export function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 255) return false;
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:'
      || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')));
  } catch {
    return false;
  }
}

export function isSubscriptionCollection(value: unknown): value is Subscription[] {
  return Array.isArray(value) && value.length <= MAX_SUBSCRIPTIONS
    && value.every(isSubscription) && new Set(value.map((entry: Subscription) => entry.id)).size === value.length;
}

export function isFindingHistory(value: unknown): value is FindingRecord[] {
  return Array.isArray(value) && value.length <= MAX_REVIEW_HISTORY
    && value.every(isFindingRecord) && new Set(value.map((entry: FindingRecord) => entry.id)).size === value.length;
}
