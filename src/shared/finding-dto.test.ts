import { expect, it } from 'vitest';

import { hasSensitiveDisplayData } from '../core/sensitive';
import type { Finding } from '../core/types';
import { isFindingDto, isFindingDtoBatch, MAX_EXCERPT_LENGTH, toFindingDto } from './finding-dto';

const rawFinding: Finding = {
  id: 'local-only', kind: 'recurring-charge', reason: 'price-cadence', severity: 'notice',
  title: 'Possible recurring charge', explanation: 'Review the schedule',
  evidence: '$10 per month', selector: '#private',
};

const fingerprint = 'a'.repeat(64);

it('accepts safe evidence but rejects a masked card with the same valid fingerprint', () => {
  expect(toFindingDto(rawFinding, 'req-1', 1, fingerprint)).not.toBeNull();
  expect(toFindingDto({ ...rawFinding, evidence: '$10 per month card •••• 1234' }, 'req-1', 1, fingerprint)).toBeNull();
});

// @ts-expect-error A fingerprint must be supplied at the producer boundary.
void (() => toFindingDto(rawFinding, 'req-1', 1));
const valid = () => toFindingDto(rawFinding, 'req-1', 1, fingerprint)!;

it('serializes only seven safe keys and normalized visible static text', () => {
  const dto = toFindingDto({ ...rawFinding, evidence: '  $10\n per   month  ' }, 'req-1', 1, fingerprint);
  expect(dto).toEqual({ version: 1, requestId: 'req-1', kind: 'recurring-charge',
    reason: 'price-cadence', screenedExcerpt: '$10 per month', opaqueFingerprint: fingerprint, ordinal: 1 });
  const json = JSON.stringify(dto);
  for (const forbidden of ['selector', 'evidence', 'url', 'pageTitle', 'formValue', '#private', 'local-only']) {
    expect(json).not.toContain(forbidden);
  }
});

it('accepts 160 characters and rejects 161 on receipt', () => {
  expect(toFindingDto({ ...rawFinding, evidence: 'A'.repeat(160) }, 'req-1', 1, fingerprint)?.screenedExcerpt).toHaveLength(160);
  expect(isFindingDto({ ...valid(), screenedExcerpt: 'A'.repeat(160) })).toBe(true);
  expect(isFindingDto({ ...valid(), screenedExcerpt: 'A'.repeat(161) })).toBe(false);
});

it('screens the entire source before truncation, not merely the excerpt', () => {
  for (const evidence of [`${'A'.repeat(160)} email jane@example.com`, `${'A'.repeat(160)} card •••• 1234`]) {
    expect(toFindingDto({ ...rawFinding, evidence }, 'req-1', 1, fingerprint)).toBeNull();
  }
});

it('rejects a PAN exposed only by truncating a longer contiguous number', () => {
  // The full 20-digit run has no 12–19-digit word-bounded PAN match; the cut leaves 16 digits.
  const evidence = `${'A'.repeat(MAX_EXCERPT_LENGTH - 17)} ${'1'.repeat(20)}`;
  const excerpt = evidence.slice(0, MAX_EXCERPT_LENGTH);
  expect(hasSensitiveDisplayData(evidence)).toBe(false);
  expect(excerpt).toHaveLength(MAX_EXCERPT_LENGTH);
  expect(hasSensitiveDisplayData(excerpt)).toBe(true);
  expect(isFindingDto({ ...valid(), screenedExcerpt: excerpt })).toBe(false);
  expect(toFindingDto({ ...rawFinding, evidence }, 'req-1', 1, fingerprint)).toBeNull();
});

it('rejects sensitive excerpt supplied directly to the wire validator', () => {
  for (const screenedExcerpt of ['card •••• 1234', 'jane@example.com', 'Account number 12345678',
    'CVV 123', 'https://example.test/path', 'www.example.test/checkout', 'Card xxxx 4242']) {
    expect(isFindingDto({ ...valid(), screenedExcerpt })).toBe(false);
    expect(toFindingDto({ ...rawFinding, evidence: screenedExcerpt }, 'req-1', 1, fingerprint)).toBeNull();
  }
});

it('rejects bare domains and non-HTTP scheme URLs throughout source and on receipt', () => {
  for (const text of ['Subscription renewal example.com', 'Subscription renewal ftp://example.com',
    'Subscription renewal example.co.uk', 'Subscription renewal ftp://localhost']) {
    expect(toFindingDto({ ...rawFinding, evidence: text }, 'req-1', 1, fingerprint)).toBeNull();
    expect(isFindingDto({ ...valid(), screenedExcerpt: text })).toBe(false);
    expect(toFindingDto({ ...rawFinding, evidence: `${'A'.repeat(160)} ${text}` }, 'req-1', 1, fingerprint)).toBeNull();
  }
});

it('rejects Unicode and IDN domains with paths or queries on both boundaries', () => {
  for (const text of [
    'Subscription renewal 例子.中国/checkout?token=secret',
    'Subscription renewal 例子.中国',
    'Subscription renewal shop例子.com/checkout?token=secret',
    'Subscription renewal example.xn--fiqs8s/checkout?token=secret',
    'Subscription renewal xn--fsqu00a.xn--fiqs8s/checkout?token=secret',
  ]) {
    expect(toFindingDto({ ...rawFinding, evidence: text }, 'req-1', 1, fingerprint)).toBeNull();
    expect(isFindingDto({ ...valid(), screenedExcerpt: text })).toBe(false);
  }
});

it('rejects an IDN hidden beyond the 160-character excerpt', () => {
  const evidence = `${'A'.repeat(160)} Subscription renewal 例子.中国/checkout?token=secret`;
  expect(toFindingDto({ ...rawFinding, evidence }, 'req-1', 1, fingerprint)).toBeNull();
});

it('rejects standalone relative paths and query strings on both DTO boundaries', () => {
  for (const text of ['Monthly plan /checkout?token=private', '?token=private',
    'checkout?token=private', '/checkout', '/checkout/step']) {
    expect(isFindingDto({ ...valid(), screenedExcerpt: text })).toBe(false);
    expect(toFindingDto({ ...rawFinding, evidence: text }, 'req-1', 1, fingerprint)).toBeNull();
  }
});

it('screens relative paths and queries in source before truncating', () => {
  for (const tail of ['/checkout/step', '?token=private', 'checkout?token=private']) {
    expect(toFindingDto({ ...rawFinding, evidence: `${'A'.repeat(160)} ${tail}` },
      'req-1', 1, fingerprint)).toBeNull();
  }
});

it('rejects zero-width, bidi and other format controls on both boundaries', () => {
  for (const text of ['Subscription card ••••\u200b1234', 'Subscription card 4111\u200b1111\u200b1111\u200b1111',
    'Subscription renewal\u202e monthly', 'Subscription renewal\u0000 monthly',
    'Subscription renewal\u0085 monthly']) {
    expect(toFindingDto({ ...rawFinding, evidence: text }, 'req-1', 1, fingerprint)).toBeNull();
    expect(isFindingDto({ ...valid(), screenedExcerpt: text })).toBe(false);
    expect(toFindingDto({ ...rawFinding, evidence: `${'A'.repeat(160)} ${text}` }, 'req-1', 1, fingerprint)).toBeNull();
  }
});

it('keeps benign subscription text and decimal prices without domain false positives', () => {
  for (const text of ['Subscription renews monthly', '$10.00 per month', 'Save 20% on annual plan',
    '订阅每月续费', 'Plan costs $12 per month', 'Save 20%', 'Renewal date 2026-09-28']) {
    expect(toFindingDto({ ...rawFinding, evidence: text }, 'req-1', 1, fingerprint)?.screenedExcerpt).toBe(text);
    expect(isFindingDto({ ...valid(), screenedExcerpt: text })).toBe(true);
  }
});

it('rejects extra keys, unsupported versions and kind/reason combinations', () => {
  for (const extra of [{ selector: '#private' }, { evidence: 'raw' }, { url: 'https://example.test/x' },
    { pageTitle: 'private' }, { formValue: 'private' }, { version: 2 },
    { kind: 'preselected-addon', reason: 'price-cadence' },
    { kind: 'recurring-charge', reason: 'checked-paid-control' }]) {
    expect(isFindingDto({ ...valid(), ...extra })).toBe(false);
  }
});

it('rejects malformed identity, ordinal, and non-normalized excerpts', () => {
  for (const requestId of ['', 'req/1', 'https://example.test', 'foo@bar.com', 'a'.repeat(129)]) {
    expect(isFindingDto({ ...valid(), requestId })).toBe(false);
    expect(toFindingDto(rawFinding, requestId, 1, fingerprint)).toBeNull();
  }
  for (const ordinal of [0, -1, 1.5, 101, Infinity]) expect(isFindingDto({ ...valid(), ordinal })).toBe(false);
  for (const opaqueFingerprint of ['', 'abc', 'Z'.repeat(64), 'f'.repeat(65)]) {
    expect(isFindingDto({ ...valid(), opaqueFingerprint })).toBe(false);
  }
  for (const screenedExcerpt of ['', '  $10 per month', 'A\nB', 'A  B']) {
    expect(isFindingDto({ ...valid(), screenedExcerpt })).toBe(false);
  }
});

it('bounds a complete batch to 100 DTOs', () => {
  expect(isFindingDtoBatch(Array.from({ length: 100 }, valid))).toBe(true);
  expect(isFindingDtoBatch(Array.from({ length: 101 }, valid))).toBe(false);
  expect(isFindingDtoBatch([valid(), { ...valid(), selector: '#x' }])).toBe(false);
});
