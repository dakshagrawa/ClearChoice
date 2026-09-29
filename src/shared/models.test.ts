import { expect, it } from 'vitest';
import { isSubscription, isFindingRecord, isFindingHistory, isSubscriptionCollection, normalizeMerchant, normalizeCurrency } from './models';

const subscription = {
  id: 'sub-1', merchant: 'Example Market', amount: '12.50', currency: 'USD',
  cadence: 'monthly', createdAt: '2026-09-28T12:00:00.000Z', updatedAt: '2026-09-28T12:00:00.000Z',
};

it('accepts an exact manually entered subscription without a finding', () => {
  expect(isSubscription(subscription)).toBe(true);
});

it('preserves a benign decimal price in notes', () => {
  expect(isSubscription({ ...subscription, notes: 'Paid $10.00 monthly' })).toBe(true);
});

it('normalizes merchant whitespace and currency case explicitly', () => {
  expect(normalizeMerchant('  Example   Market  ')).toBe('Example Market');
  expect(normalizeCurrency('usd')).toBe('USD');
});

it.each([
  { amount: '1e3' }, { amount: '0.00' }, { amount: '01.00' }, { amount: '1.234' },
  { currency: 'ZZZ' }, { currency: 'usd' }, { merchant: '  Example Market' },
  { nextBillingDate: '2026-02-29' }, { nextBillingDate: '2026-13-01' },
  { notes: 'a'.repeat(501) }, { evidence: 'raw page data' }, { selector: '#card' },
  { url: 'https://example.com/checkout' }, { sourceFindingId: '' },
  { createdAt: '2026-02-30T12:00:00.000Z' },
])('rejects malformed subscription field %j', (change) => {
  expect(isSubscription({ ...subscription, ...change })).toBe(false);
});

it('requires a description only for custom cadence and accepts optional valid fields', () => {
  expect(isSubscription({ ...subscription, cadence: 'custom' })).toBe(false);
  expect(isSubscription({ ...subscription, cadence: 'custom', customDescription: 'Every five weeks',
    nextBillingDate: '2028-02-29', sourceFindingId: 'finding-1' })).toBe(true);
  expect(isSubscription({ ...subscription, customDescription: 'Every five weeks' })).toBe(false);
});

const finding = {
  id: 'finding-1', origin: 'https://example.com', kind: 'recurring-charge', reason: 'price-cadence',
  screenedExcerpt: 'Monthly plan $10.00', opaqueFingerprint: 'a'.repeat(64), ordinal: 1,
  firstSeen: '2026-09-28T12:00:00.000Z', latestSeen: '2026-09-28T12:01:00.000Z', status: 'needs-review',
};

it('accepts screened review history independent of subscriptions', () => {
  expect(isFindingRecord(finding)).toBe(true);
  expect(isFindingHistory([finding])).toBe(true);
  expect(isSubscriptionCollection([subscription])).toBe(true);
});

it.each([
  { origin: 'http://example.com' }, { origin: 'https://example.com/path' },
  { origin: 'https://example.com?secret=1' }, { origin: 'https://u:p@example.com' },
  { screenedExcerpt: 'card •••• 1234' }, { screenedExcerpt: 'https://example.com/checkout' },
  { screenedExcerpt: 'a'.repeat(161) }, { opaqueFingerprint: 'not-a-digest' },
  { ordinal: 101 }, { reason: 'checked-paid-control' }, { status: 'confirmed' },
  { latestSeen: '2026-09-28T11:00:00.000Z' }, { selector: '#pay' }, { evidence: 'raw' },
])('rejects unsafe or malformed finding %j', (change) => {
  expect(isFindingRecord({ ...finding, ...change })).toBe(false);
});

it('accepts localhost fixtures but not other plaintext origins', () => {
  expect(isFindingRecord({ ...finding, origin: 'http://localhost:4173' })).toBe(true);
  expect(isFindingRecord({ ...finding, origin: 'http://127.0.0.1:4173' })).toBe(true);
  expect(isFindingRecord({ ...finding, origin: 'http://192.168.1.1' })).toBe(false);
});

it('accepts the full 500-record history capacity and rejects one more', () => {
  const records = Array.from({ length: 500 }, (_, index) => ({ ...finding, id: `finding-${index}` }));
  expect(isFindingHistory(records)).toBe(true);
  expect(isFindingHistory([...records, { ...finding, id: 'finding-500' }])).toBe(false);
});

it('rejects duplicate IDs and over-capacity collections without truncation', () => {
  expect(isFindingHistory([finding, finding])).toBe(false);
  expect(isSubscriptionCollection([subscription, subscription])).toBe(false);
  expect(isFindingHistory(Array(501).fill(finding))).toBe(false);
  expect(isSubscriptionCollection(Array(501).fill(subscription))).toBe(false);
});
