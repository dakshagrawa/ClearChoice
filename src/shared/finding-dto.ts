import { normalizeVisibleText } from '../core/normalize';
import { hasSensitiveDisplayData } from '../core/sensitive';
import type { Finding, FindingKind, FindingReason } from '../core/types';

export const FINDING_WIRE_VERSION = 1 as const;
export const MAX_FINDING_BATCH = 100;
export const MAX_EXCERPT_LENGTH = 160;
export const MAX_ORDINAL = 100;

export interface FindingDto {
  version: typeof FINDING_WIRE_VERSION;
  requestId: string;
  kind: FindingKind;
  reason: FindingReason;
  screenedExcerpt: string;
  opaqueFingerprint: string;
  ordinal: number;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
// Screen whole candidates rather than trying to redact paths or query strings. A letter-only
// final label avoids treating decimal prices like $10.00 as domains; punycode TLDs need
// their own branch because they contain hyphens and digits.
const URL = /(?:\b[a-z][a-z0-9+.-]*:\/\/|[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:[.。．｡][\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*[.。．｡](?:\p{L}{2,}|xn--[a-z0-9-]*[a-z0-9])(?![\p{L}\p{N}-]))/iu;
// Relative URL components can leak checkout routes or query parameters without a domain.
// Require a letter after / so numeric dates and decimal prices remain static text.
const RELATIVE_URL = /(?:\/[\p{L}][\p{L}\p{N}_-]*(?:\/[\p{L}][\p{L}\p{N}_-]*)*|\?[\p{L}_][\p{L}\p{N}_.~-]*(?:=|&))/u;
export function hasUnsafeUrlText(text: string): boolean {
  return URL.test(text) || RELATIVE_URL.test(text);
}
// Reject format/bidi and control characters before normalization or sensitive matching.
// TAB, LF and CR remain safe in raw evidence because normalization collapses them.
const FORMAT_CHARACTER = /\p{Cf}/u;
function hasUnsafeControl(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.codePointAt(0)!;
    return FORMAT_CHARACTER.test(character)
      || (code < 32 && code !== 9 && code !== 10 && code !== 13)
      || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
  });
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

export function isValidFindingPair(kind: unknown, reason: unknown): kind is FindingKind {
  return (kind === 'recurring-charge' && (reason === 'price-cadence' || reason === 'renewal-language' || reason === 'subscription-language'))
    || (kind === 'preselected-addon' && reason === 'checked-paid-control');
}

export function isFindingDto(value: unknown): value is FindingDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const dto = value as Record<string, unknown>;
  const keys = ['version', 'requestId', 'kind', 'reason', 'screenedExcerpt', 'opaqueFingerprint', 'ordinal'];
  if (Object.keys(dto).length !== keys.length || !keys.every((key) => Object.hasOwn(dto, key))) return false;
  if (dto.version !== FINDING_WIRE_VERSION || !isValidRequestId(dto.requestId)
    || !isValidFindingPair(dto.kind, dto.reason)
    || typeof dto.opaqueFingerprint !== 'string' || !FINGERPRINT.test(dto.opaqueFingerprint)
    || !Number.isInteger(dto.ordinal) || (dto.ordinal as number) < 1 || (dto.ordinal as number) > MAX_ORDINAL
    || typeof dto.screenedExcerpt !== 'string') return false;
  const excerpt = dto.screenedExcerpt;
  return excerpt.length > 0 && excerpt.length <= MAX_EXCERPT_LENGTH
    && normalizeVisibleText(excerpt) === excerpt && !hasUnsafeControl(excerpt)
    && !hasUnsafeUrlText(excerpt) && !hasSensitiveDisplayData(excerpt);
}

/** Fingerprinting belongs to the content-side batch producer (Task 3), not this DTO. */
export function toFindingDto(raw: Finding, requestId: string, ordinal: number, opaqueFingerprint: string): FindingDto | null {
  if (typeof raw.evidence !== 'string' || hasUnsafeControl(raw.evidence)
    || hasUnsafeUrlText(raw.evidence) || hasSensitiveDisplayData(raw.evidence)) return null;
  const normalized = normalizeVisibleText(raw.evidence);
  if (normalized.length === 0 || hasUnsafeUrlText(normalized) || hasSensitiveDisplayData(normalized)) return null;
  const candidate = {
    version: FINDING_WIRE_VERSION,
    requestId, kind: raw.kind, reason: raw.reason,
    screenedExcerpt: normalized.slice(0, MAX_EXCERPT_LENGTH).trim(),
    opaqueFingerprint, ordinal,
  };
  return isFindingDto(candidate) ? candidate : null;
}

export function isFindingDtoBatch(value: unknown): value is FindingDto[] {
  return Array.isArray(value) && value.length <= MAX_FINDING_BATCH && value.every(isFindingDto);
}
