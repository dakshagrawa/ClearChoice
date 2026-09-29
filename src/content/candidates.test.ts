import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { makeFinding } from '../core/dedupe';
import { detectPreselectedAddons, detectRecurringCharges } from '../core/detector';
import { isFindingsBatchRequest } from '../shared/messages';
import { buildFindingBatch, createScanRequestId } from './candidates';

const requestId = 'scan-1';
const originalCrypto = globalThis.crypto;
const paidOption = (selector: string) => makeFinding(
  'recurring-charge', 'price-cadence', 'notice', 'Possible recurring charge',
  'Check before continuing', 'Plan costs $12 per month', selector,
);

// JSDOM may lack SubtleCrypto; the extension uses Chromium's built-in Web Crypto.
vi.stubGlobal('crypto', webcrypto);
afterEach(() => vi.stubGlobal('crypto', originalCrypto));

it('assigns stable opaque fingerprints and distinct ordinals to equal paid options', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const findings = [paidOption('section:nth-child(1)'), paidOption('section:nth-child(2)')];
  const first = await buildFindingBatch(findings, requestId);
  const repeated = await buildFindingBatch(findings, 'scan-2');

  expect(first.findings.map(({ opaqueFingerprint, ordinal }) => [opaqueFingerprint, ordinal]))
    .toEqual([[first.findings[0]?.opaqueFingerprint, 1], [first.findings[0]?.opaqueFingerprint, 2]]);
  expect(first.findings[0]?.opaqueFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(repeated.findings.map(({ opaqueFingerprint, ordinal }) => [opaqueFingerprint, ordinal]))
    .toEqual(first.findings.map(({ opaqueFingerprint, ordinal }) => [opaqueFingerprint, ordinal]));
  expect(JSON.stringify(first)).not.toMatch(/section|selector|evidence|Plan costs.*section/);
});

it('rejects 101 eligible findings rather than emitting a partial or invalid batch', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const findings = Array.from({ length: 101 }, (_, i) => paidOption(`section:nth-child(${i + 1})`));
  await expect(buildFindingBatch(findings, requestId)).rejects.toThrow(/batch|100|limit/i);
  const bounded = await buildFindingBatch(findings.slice(0, 100), requestId);
  expect(bounded.findings).toHaveLength(100);
  expect(bounded.findings[99]?.ordinal).toBe(100);
  expect(isFindingsBatchRequest(bounded)).toBe(true);
});

it('creates one strong scan ID that the caller can reuse for a retry', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const id = createScanRequestId();
  expect(id).toMatch(/^[a-f0-9]{32}$/);
  expect(createScanRequestId()).not.toBe(id);
  const first = await buildFindingBatch([paidOption('section')], id);
  const retry = await buildFindingBatch([paidOption('section')], id);
  expect(retry).toEqual(first);
  expect(retry.findings[0]?.requestId).toBe(id);
});

it('rejects malformed scan IDs before hashing and never returns an empty invalid batch', async () => {
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn() } });
  await expect(buildFindingBatch([paidOption('section')], 'bad id')).rejects.toThrow(/request/i);
  await expect(buildFindingBatch([], 'bad id')).rejects.toThrow(/request/i);
  expect(crypto.subtle.digest).not.toHaveBeenCalled();
});

it('fails closed when Web Crypto is unavailable, including an empty scan', async () => {
  vi.stubGlobal('crypto', undefined);
  expect(() => createScanRequestId()).toThrow(/crypto/i);
  await expect(buildFindingBatch([], requestId)).rejects.toThrow(/crypto/i);
  await expect(buildFindingBatch([paidOption('section')], requestId)).rejects.toThrow(/crypto/i);
});

it('screens whole candidate evidence before hashing and excludes sensitive candidates', async () => {
  const digest = vi.spyOn(webcrypto.subtle, 'digest');
  vi.stubGlobal('crypto', webcrypto);
  try {
    const safe = paidOption('safe');
    const sensitive = { ...paidOption('secret'), evidence: 'Plan costs $12 per month card •••• 1234' };
    const batch = await buildFindingBatch([sensitive, safe], requestId);
    expect(batch.findings).toHaveLength(1);
    expect(batch.findings[0]?.screenedExcerpt).toBe(safe.evidence);
    expect(digest).toHaveBeenCalledTimes(1);
    const hashed = new TextDecoder().decode(digest.mock.calls[0]?.[1] as BufferSource);
    expect(hashed).toBe(`recurring-charge\u0000price-cadence\u0000${safe.evidence}`);
    expect(JSON.stringify(batch)).not.toMatch(/secret|1234|selector|evidence/);
  } finally { digest.mockRestore(); }
});

it('uses upstream detectors to exclude editable/form values and sensitive labels', async () => {
  vi.stubGlobal('crypto', webcrypto);
  document.body.innerHTML = `
    <section>Plan costs $12 per month</section>
    <section contenteditable="false">Plan costs $15 per month</section>
    <form><input value="card 4111111111111111"><textarea>Plan costs $20 per month</textarea></form>
    <label><input type="checkbox" checked> Protection $5 card •••• 1234</label>
    <label><input type="checkbox" checked> Protection $7</label>`;
  const findings = [
    ...detectRecurringCharges(document.body),
    ...detectPreselectedAddons(document.body),
  ];
  const batch = await buildFindingBatch(findings, requestId);
  expect(batch.findings.map((f) => f.screenedExcerpt)).toEqual([
    'Plan costs $12 per month', 'Protection $7',
  ]);
  expect(JSON.stringify(batch)).not.toMatch(/411111|1234|\$15|\$20|card/i);
});

it('preserves caller DOM order and assigns ordinals deterministically even with identical selectors', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const first = paidOption('section');
  const middle = { ...paidOption('section'), evidence: 'Plan costs $15 per month' };
  const ordered = [first, middle, first];
  const batch = await buildFindingBatch(ordered, requestId);
  expect(batch.findings.map(({ screenedExcerpt, ordinal }) => [screenedExcerpt, ordinal])).toEqual([
    [first.evidence, 1], [middle.evidence, 1], [first.evidence, 2],
  ]);
  expect(await buildFindingBatch(ordered, requestId)).toEqual(batch);
});

it('counts only eligible findings against the 100-item bound', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const eligible = Array.from({ length: 100 }, () => paidOption('section'));
  const excluded = { ...paidOption('section'), evidence: 'Plan costs $12 per month user@example.com' };
  expect((await buildFindingBatch([excluded, ...eligible], requestId)).findings).toHaveLength(100);
});
