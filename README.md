# ClearChoice 1.0.0-rc.3 production release candidate

## License and contributions

Copyright (c) 2026 Daksh Agrawal. ClearChoice is **proprietary and source-available, not open source**. Personal, noncommercial evaluation, controlled beta testing, and preparing contributions are permitted only as described in [LICENSE](LICENSE). Reuse in another product, commercial exploitation, and redistribution outside those permissions require prior written permission. GitHub viewing/forking rights, applicable law, prior valid grants, and third-party licenses remain unaffected. Issues and PRs are welcome under [CONTRIBUTING.md](CONTRIBUTING.md).

This is the unreleased `1.0.0-rc.3` production release candidate, not release-ready or published. Notices are advisory-only; false positives and false negatives remain possible. ClearChoice makes no legal, compliance, safety, or deceptive-site conclusion and does not automate purchases, payments, account actions, cancellations, refunds, or form submission. Chrome Web Store review and submission are future separate work, not complete. Production acceptance remains blocked; human QA is stopped. See [production readiness](./production-readiness.md).

The popup is 520px wide, uses light/dark design tokens, and makes **Analyze** the primary action. Subscriptions appear before history; explanations expand through a keyboard-focusable summary. These changes refine existing behavior and do not establish final polish or stable approval.

## Analyze and opt in

Manual **Analyze** uses temporary `activeTab` access and needs no automatic-scanning opt-in. Required permissions are `activeTab`, `scripting`, and `storage`; `host_permissions` is empty by default. Optional `https://*/*` declares the ability to request access, not broad granted access. **Enable detection for this site** requests one exact HTTPS origin through Chrome on your click. That revocable grant permits automatic observation on supported English consumer checkout pages at that origin. Account, login, payment-sensitive, restricted, and unsupported pages are skipped. No static content scripts run by default; the worker registers exact-origin scripts after permission checks.

One extension **Enable detection for this site** click starts a worker-owned operation; native Chrome **Allow** lets that operation complete. Popup disappearance does not own completion. The popup calls `sendMessage` synchronously before awaiting, and the worker calls `permissions.request` synchronously before awaiting. Completion is bound to the exact sender, origin, and tab through a cancelable in-memory operation that expires after 120 seconds. Arbitrary `permissions.onAdded` events and persisted pending consent cannot enable detection.

Unexpected worker termination or lost operation state can leave browser access without detection. Reopen the popup to inspect status, or remove site access in Chrome Settings. Recovery must report an unknown outcome truthfully; permission presence alone must not replay Enable or be treated as an application grant. Permission, registration, and storage steps are not an atomic transaction.

Automatic panels appear only after an accepted worker acknowledgement for a positive finding. Zero findings and unsupported pages stay quiet on-page; badge/popup status carries the outcome. Manual zero-findings analysis also leaves no empty findings panel or Cancellation Help footer. Analyze and Restore do not change checkout controls or submit forms.

## Review and subscriptions

Automatic observations enter **Needs review**; ClearChoice never automatically confirms a subscription. Automatic observation and **Mark reviewed** do not confirm or create a subscription. You can create, read, edit, and delete local confirmed subscriptions manually. **Review as subscription** opens a draft from your own source finding ID; ambiguous values remain blank. **Save subscription** explicitly confirms the observation and creates a local subscription. Duplicate source-finding protection and refresh invalidation prevent stale review submissions. Merchant, amount, currency, cadence, and optional notes are normalized and screened user-entered fields, not account or payment details. Do not enter identifying, account, or payment information. If a manual Create acknowledgement is lost, inspect the list before retrying: a retry can create a duplicate.

## Local data and Cancellation Help

All page data stays local. There is no telemetry, accounts, or uploads, backend, sync, remote configuration, or cloud guide service. Analysis excludes typed input, textarea, select, and contenteditable values. A sensitive-looking static context or finding candidate is discarded whole, not redacted and retained. Screening rejects email, payment-card/PAN/masked-card, account/bank/routing-number, CVV, and security-code patterns.

Finding transport carries a privacy-screened excerpt, kind/reason, opaque fingerprint, and occurrence ordinal, plus version, request, and authorization metadata. The worker derives the canonical origin from validated sender context; the worker owns record IDs, first/latest-seen timestamps, and review status. The popup receives screened record fields (ID, canonical origin, kind/reason, excerpt, first/latest-seen timestamps, and review status) without the fingerprint or ordinal. There are no raw URL paths, queries, selectors, HTML, or form values in those messages or local records.

The worker stores at most 500 retained observations in `chrome.storage.local`. Retention choices are 7/30/90/Never days, with 30 days by default. Expiry uses the UTC cutoff and `latestSeen`; Never disables age expiry, not the cap. Confirmed subscriptions stay until you delete them, independently of observation expiry. Settings, grants, dismissal state, and bounded duplicate receipts also stay local.

**Cancellation Help** runs only when you click it and only from a retained, unexpired source observation's canonical origin. The bundled catalog contains four exact Netflix/Spotify origins with official guides; a known-origin fallback can show the source origin instead. A manually entered merchant name never selects a provider. Expired or deleted source observations supply no link. A second HTTPS anchor click makes the browser navigate to the provider article or known source origin; this user-initiated browser navigation is not an extension service upload. The extension does not cancel anything. Deleting a local subscription does not cancel billing.

Catalog metadata was reviewed September 29, 2026; official articles were rechecked September 30 in Task 14. Provider instructions can change. The catalog is bundled, not fetched from a server.

## Contributor checks

Contributors need Node **24** (currently verified: **Node 24.21.0**); `.nvmrc` pins the same major.

```sh
npm ci
npm test -- --run --maxWorkers=2
npm run lint
npm run build
npm run e2e -- --workers=1
npm run package:unpacked
npm run verify:archive
npm audit --omit=dev
```

Run bounded unit and native browser tests before packaging the final candidate. Commands are instructions, not a claim that every check passed. `npm run package:unpacked` rebuilds: do not run it after human attestation. `npm run check:beta` then validates the existing archive and marker, not a rebuilt artifact.

Loopback mock fixtures cannot use **Enable detection for this site**: `isGrantOrigin` rejects IP addresses and localhost. Reserved `.test` browser harness origins map locally with pregranted Chrome permissions. They are automated setup, not genuine human consent. Do not use live account or payment checkouts to work around fixtures.

Current automated native evidence is limited to Chromium 141 on Linux; other platforms and Chrome versions are unverified. Published RC2's native Allow diagnostic left browser permission true, the application grant absent, and zero registered scripts. A working diagnostic artifact before M1 acknowledgement-recovery metadata revision 3 verified fresh Allow → application grant true with the correct isolated script, and Deny → no access, application grant, or script. The popup closed and reopened without a second Enable click. This used synthetic automated native OS input, not human attestation, a final RC3 artifact binding, or a full gate pass.

The parent broad run had 918 unit tests green before M1; M1's focused parent run had 36 green. The E2E run passed 20/22, with two brittle capacity-probe aliases being fixed by another owner. M1 source is complete but re-review and full final verification remain pending. Fresh RC3 CI, final artifact verification, and final human acceptance are unresolved. The user stopped human QA; no stable approval or publication is claimed.

Read [privacy](PRIVACY.md), [architecture](docs/architecture.md), and [release gates](docs/beta-release-checklist.md). The [existing manual protocol](docs/beta-test-protocol.md) still needs the Task 16B expansion. Feedback is optional and external; use [the sanitized template](docs/beta-feedback-template.md).

## Historical prototypes

**v0.1.0 and v0.2.0 are archived mock-only localhost fixture prototypes, not beta support.** Their preserved private releases are <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.1.0> and <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0>. Use only their controlled localhost fixtures and the v0.2.0 historical [release checklist](docs/release-checklist.md); do not interpret either archive as real-site support, production readiness, or beta eligibility.

### Access and load an archived prototype

1. Sign in to GitHub with the repository-owner account or an invited collaborator account. If either private release link is unavailable, ask the repository owner to grant repository access; do not request a public copy.
2. Download the release ZIP, extract it locally, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and choose the extracted directory that contains `manifest.json`.
3. For the matching archived tag's controlled fixture server, check out that tag, run `npm ci`, then run `npm run serve:fixtures`. Follow the release notes for its exact local fixture route.
4. Use the archive only with that localhost fixture. Do not load it on third-party checkout pages or treat it as the current beta.

## External compliance references

Retrieved **2026-09-23**:

- <https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>
- <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- <https://developer.chrome.com/docs/webstore/program-policies>

Chrome Web Store policy review and submission are future separate work, not complete.
