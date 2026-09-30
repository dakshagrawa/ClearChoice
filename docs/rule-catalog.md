# ClearChoice 0.3.0-beta.1 rule catalog

These rules are advisory-only heuristics for **English consumer checkout** pages in the private opt-in beta. A notice is not a conclusion that a site is deceptive, legal, illegal, compliant, safe, or unsafe. Testers must compare any notice with the visible page text.

## R1 — Possible recurring charge

**Signal:** visible text includes a currency amount with `/` or `per` followed by `month`, `week`, or `year`; `billed`, `charged`, or `renews automatically` near a cadence; or weaker language such as `subscription`, `recurring payment`, or `auto-renew`.

**Output:** `Possible recurring charge`, with `notice` for stronger recurring-charge evidence and `info` for bare subscription language.

**Known false positives:** policy copy, educational text, historical invoices, non-purchase memberships, free-trial descriptions, and unrelated visible text can match. A match does not prove a charge exists or will recur.

**Known false negatives:** wording outside the listed patterns, non-textual disclosures, hidden content, and unsupported DOM contexts can be missed.

## R2 — Preselected paid option

**Signal:** a visible checked checkbox or radio control has an associated visible label containing a currency amount or words such as `paid`, `premium`, `protection`, or `membership`.

**Output:** `Preselected paid option` with `notice` severity.

**Known false positives:** included benefits, no-cost options using a keyword, comparison prices, and non-purchase selections can match. A match does not establish that an option costs money.

**Known false negatives:** paid options without the listed currencies or keywords, unlabeled controls, unchecked options, hidden controls, and non-checkbox/radio controls can be missed.

## Data and action limits

The rules do not inspect typed form or `contenteditable` values. Static visible text may be transiently inspected while evaluating a candidate, but a candidate containing email, payment-card/PAN or masked-card, account/bank/routing number, CVV, or security-code text is discarded whole rather than redacted or retained. ClearChoice does not alter controls, prices, forms, payments, accounts, cancellations, or checkout submission.

## Reviewed cancellation-guide catalog (preparatory)

`src/shared/guide-catalog.ts` exports a pure synchronous resolver:

```ts
resolveCancellationGuide(origin: unknown): CancellationGuideResolution
```

Its readonly discriminated union returns frozen objects:

- `kind: 'guide'`: `label: 'Official cancellation guide'`, `destination`, `title`,
  `sourceURL`, `lastReviewed` (ISO date), and `caveat`.
- `kind: 'site'`: `label: 'Visit site'` and `originURL`, exactly the input origin.
- `kind: 'none'`: no destination available.

Only these literal origins select reviewed articles:

| Literal origins | Article title | Destination and source URL | Last reviewed |
| --- | --- | --- | --- |
| `https://netflix.com`, `https://www.netflix.com` | How to cancel Netflix | https://help.netflix.com/en/node/407 | 2026-09-29 |
| `https://spotify.com`, `https://www.spotify.com` | How to cancel Premium plans | https://support.spotify.com/us/article/cancel-premium/ | 2026-09-29 |

This is a fixed local allowlist, not hostname suffix matching. Other canonical
HTTPS origins receive only **Visit site**; that label does not imply a reviewed
provider, endorsement, or a known cancellation route. This includes arbitrary
subdomains, lookalike domains and canonical ASCII punycode origins. No path or
search URL is inferred. An origin is not proof of a subscription or billing relationship.

The caller must supply an already-known origin from its validated record, not a
merchant name. Manually typing “Netflix” or “Spotify” returns `none`, as does an
object containing either name. Raw page URLs, trailing slashes, query strings,
fragments, credentials, explicit ports (including `:443`), whitespace, noncanonical
case, Unicode host spellings, and non-HTTPS schemes are rejected rather than
normalized into a match. HTTP localhost/loopback is also rejected. Canonical input
is bounded to 255 characters. The resolver neither grants permission nor verifies
that an origin belongs to the merchant.

### Provenance and limitations

The official public help articles above were extracted and reviewed on 2026-09-29.
The review date records that check, not a guarantee that future instructions remain
current. The destination is the same fixed HTTPS article as the provenance source;
no account-management or executable cancellation-action URL is stored.

Netflix's source states that signing out or deleting the app does not cancel the
membership. Spotify's source states that partner-company billing requires contacting
the partner, and that a Family/Duo member leaving the plan does not cancel the
manager's plan. Both results include the generic conditional warning:

> If billed through a third party, cancellation may need to be handled by that billing provider.

Spotify also includes:

> Leaving a Family or Duo plan as a member does not cancel the plan; contact the plan manager.

The generic warning is conditional guidance, not a claim about the user's billing
provider. These guides concern subscription cancellation, not account deletion;
ClearChoice does not perform either action.

### Integration boundary

This preparatory module has no browser globals, Chrome API calls, network requests,
remote code, automatic navigation, added dependencies, or popup wiring. A later UI must
distinguish **Official cancellation guide** from **Visit site**, display the article
review date and caveat for guides, and open destinations only after an explicit user
choice. A fallback has no article review date and must not be presented as reviewed
cancellation help. Manual-only entries without an origin get no external link.

Popup integration is deferred until the subscription workflow has been reviewed;
this catalog alone does not complete Task 14 or establish browser/UI acceptance.

### Future ideas — not implemented

Server-based guide updates remain **IDEAS only**: they require a separately reviewed
architecture, provenance/freshness rules, privacy decisions, and any opt-in policy.
This slice adds no remote refresh mechanism, provider expansion, or guessed routes.
