import { expect, it } from 'vitest';

import type { Finding } from '../core/types';
import { isFindingDto, isFindingDtoBatch, toFindingDto } from './finding-dto';

const rawFinding: Finding = {
  id: 'local-only', kind: 'recurring-charge', reason: 'price-cadence', severity: 'notice',
  title: 'Possible recurring charge', explanation: 'Review the schedule',
  evidence: '$10 per month', selector: '#private',
};

it('rejects the whole candidate when its evidence includes a masked card', () => {
  expect(toFindingDto({ ...rawFinding, evidence: '$10 per month card •••• 1234' }, 'req-1', 1)).toBeNull();
});

const fingerprint = 'a'.repeat(64);
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

it('rejects sensitive excerpt supplied directly to the wire validator', () => {
  for (const screenedExcerpt of ['card •••• 1234', 'jane@example.com', 'Account number 12345678',
    'CVV 123', 'https://example.test/path', 'www.example.test/checkout', 'Card xxxx 4242']) {
    expect(isFindingDto({ ...valid(), screenedExcerpt })).toBe(false);
    expect(toFindingDto({ ...rawFinding, evidence: screenedExcerpt }, 'req-1', 1, fingerprint)).toBeNull();
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
