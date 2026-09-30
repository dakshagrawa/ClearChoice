export interface OfficialCancellationGuide {
  readonly kind: 'guide';
  readonly label: 'Official cancellation guide';
  readonly destination: string;
  readonly title: string;
  readonly sourceURL: string;
  readonly lastReviewed: string;
  readonly caveat: string;
}

export interface ProviderOriginFallback {
  readonly kind: 'site';
  readonly label: 'Visit site';
  readonly originURL: string;
}

export type CancellationGuideResolution = OfficialCancellationGuide | ProviderOriginFallback
  | Readonly<{ kind: 'none' }>;

const THIRD_PARTY_CAVEAT = 'If billed through a third party, cancellation may need to be handled by that billing provider.';
const NETFLIX: OfficialCancellationGuide = Object.freeze({
  kind: 'guide', label: 'Official cancellation guide',
  destination: 'https://help.netflix.com/en/node/407',
  title: 'How to cancel Netflix', sourceURL: 'https://help.netflix.com/en/node/407',
  lastReviewed: '2026-09-29', caveat: THIRD_PARTY_CAVEAT,
});
const SPOTIFY: OfficialCancellationGuide = Object.freeze({
  kind: 'guide', label: 'Official cancellation guide',
  destination: 'https://support.spotify.com/us/article/cancel-premium/',
  title: 'How to cancel Premium plans',
  sourceURL: 'https://support.spotify.com/us/article/cancel-premium/',
  lastReviewed: '2026-09-29',
  caveat: `${THIRD_PARTY_CAVEAT} Leaving a Family or Duo plan as a member does not cancel the plan; contact the plan manager.`,
});
const NONE = Object.freeze({ kind: 'none' } as const);

/** Resolve only an already-known literal origin, never a merchant name or full page URL.
 * This local catalog does not authenticate a provider, open a link, or cancel a subscription.
 */
export function resolveCancellationGuide(origin: unknown): CancellationGuideResolution {
  if (typeof origin !== 'string' || origin.length > 255) return NONE;
  try {
    const url = new URL(origin);
    // Equality deliberately rejects parser normalization (case, Unicode, whitespace,
    // default ports), credentials, and every path/query/fragment. Reject other ports too.
    if (url.protocol !== 'https:' || url.origin !== origin || url.port !== '') return NONE;
  } catch {
    return NONE;
  }
  switch (origin) {
    case 'https://netflix.com':
    case 'https://www.netflix.com': return NETFLIX;
    case 'https://spotify.com':
    case 'https://www.spotify.com': return SPOTIFY;
    default: return Object.freeze({ kind: 'site', label: 'Visit site', originURL: origin });
  }
}
