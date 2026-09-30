import { expect, it } from 'vitest';
import { resolveCancellationGuide } from './guide-catalog';

it.each(['https://netflix.com', 'https://www.netflix.com',
  'https://spotify.com', 'https://www.spotify.com'])('resolves only the explicit reviewed origin %s', (origin) => {
  const result = resolveCancellationGuide(origin);
  expect(result.kind).toBe('guide');
  if (result.kind !== 'guide') throw new Error('Missing reviewed guide');
  const netflix = origin.includes('netflix');
  const source = netflix ? 'https://help.netflix.com/en/node/407'
    : 'https://support.spotify.com/us/article/cancel-premium/';
  expect(result.destination).toBe(source);
  expect(result.sourceURL).toBe(source);
  expect(new URL(result.destination).protocol).toBe('https:');
  expect(result.title).toBe(netflix ? 'How to cancel Netflix' : 'How to cancel Premium plans');
  expect(result.label).toBe('Official cancellation guide');
  expect(result.lastReviewed).toBe('2026-09-29');
  expect(result.caveat).toContain('third party');
  if (!netflix) {
    expect(result.caveat).toContain('plan manager');
    expect(result.caveat).toContain('does not cancel');
  }
});

it.each([
  'https://example.com', 'https://account.netflix.com', 'https://support.spotify.com',
  'https://netflix.com.evil.test', 'https://notnetflix.com', 'https://spotify-cancel.test',
  'https://xn--ntflix-bva.com',
])('offers only the unchanged origin fallback for unreviewed canonical origin %s', (originURL) => {
  expect(resolveCancellationGuide(originURL)).toEqual({ kind: 'site', label: 'Visit site', originURL });
});

it.each([
  undefined, null, 123, {}, ['https://netflix.com'], new URL('https://netflix.com'),
  'Netflix', 'Spotify', 'Unknown merchant', '', 'netflix.com', '//netflix.com',
  'http://netflix.com', 'http://localhost', 'http://127.0.0.1',
  'javascript:alert(1)', 'data:text/html,Netflix', 'file:///netflix.com',
  'chrome://extensions', 'ftp://spotify.com',
  'https://user@netflix.com', 'https://user:pass@spotify.com',
  'https://netflix.com:443', 'https://spotify.com:8443', 'https://example.com:8443',
  'https://netflix.com/', 'https://spotify.com/account/cancel', 'https://example.com/path',
  'https://netflix.com?next=/cancel', 'https://spotify.com#cancel',
  'https://NETFLIX.com', 'HTTPS://spotify.com', ' https://netflix.com',
  'https://spotify.com\n', 'https://nétflix.com', 'https://netflіx.com',
  'https://netflix。com', 'https://ｎｅｔｆｌｉｘ.com',
])('rejects nonliteral origins, unsafe URLs and manual-only identities: %j', (input) => {
  expect(resolveCancellationGuide(input)).toEqual({ kind: 'none' });
});

it('returns deterministic immutable results without mutating inputs or shared guide data', () => {
  const input = Object.freeze({ merchant: 'Netflix', origin: 'https://netflix.com' });
  expect(resolveCancellationGuide(input)).toEqual({ kind: 'none' });
  expect(input).toEqual({ merchant: 'Netflix', origin: 'https://netflix.com' });
  for (const origin of ['https://netflix.com', 'https://spotify.com', 'https://example.com', null]) {
    const result = resolveCancellationGuide(origin);
    const before = { ...result };
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, 'kind', 'tampered')).toBe(false);
    expect(resolveCancellationGuide(origin)).toEqual(before);
  }
});

it('offers the reviewed Netflix help article for an exact approved origin', () => {
  expect(resolveCancellationGuide('https://netflix.com')).toEqual({
    kind: 'guide', label: 'Official cancellation guide',
    destination: 'https://help.netflix.com/en/node/407',
    title: 'How to cancel Netflix', sourceURL: 'https://help.netflix.com/en/node/407',
    lastReviewed: '2026-09-29',
    caveat: 'If billed through a third party, cancellation may need to be handled by that billing provider.',
  });
});
