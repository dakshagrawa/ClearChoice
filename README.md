# ClearChoice 0.4.0-beta.1 private opt-in beta

This is the unreleased `0.4.0-beta.1` private opt-in beta candidate, not release-ready or published. Notices are advisory-only; false positives and false negatives remain possible. ClearChoice makes no legal, compliance, safety, or deceptive-site conclusion and does not automate purchases, payments, account actions, cancellations, refunds, or form submission. Chrome Web Store review and submission are future separate work, not complete.

## Analyze and opt in

Manual **Analyze** uses temporary `activeTab` access and needs no automatic-scanning opt-in. Required permissions are `activeTab`, `scripting`, and `storage`; `host_permissions` is empty by default. Optional `https://*/*` declares the ability to request access, not broad granted access. **Enable detection for this site** requests one exact HTTPS origin through Chrome on your click. That revocable grant permits automatic observation on supported English consumer checkout pages at that origin. Account, login, payment-sensitive, restricted, and unsupported pages are skipped. No static content scripts run by default; the worker registers exact-origin scripts after permission checks.

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

Task 16A serialization work at `18de837` was quality-approved in the recovered review transcript `deleg_db6fb112`. Task 16B expanded human protocol and native workflow remain pending. The existing manual runner/protocol must not be treated as completed coverage for opt-in, revoke, retention, subscription CRUD, and guides. Integrated native browser checks remain unfinished. The permission hang was resolved with the exact mock-port seed. The restart harness was corrected to install once rather than reinstall on launch; packaged detector and record persistence now pass genuine browser restart checks. Four scoped packaged tests pass, including programmatic no-host denial, identical findings, unsupported-page quiet behavior, and revoked badge clearing. These pre-granted/programmatic checks do not establish human toolbar access or permission consent. Remaining adverse-state coverage is incomplete. Final human QA, full negative audit, passing beta gate, and actual final-tag CI proof are not complete.

The exact-artifact marker requires local human self-attestation bound to the exact commit, packaged manifest SHA-256, and complete ZIP SHA-256, with every required predicate passing. Verify the actual marker schema against the latest runner and validator at integration; Task 16B expands the schema and remains pending review. The Linux-only marker must be a regular external file; terminal symlinks are rejected with `O_NOFOLLOW`, and `/proc/self/fd` binds the opened descriptor outside the repository. It is not cryptographic proof of a gesture. `npm run check:beta` validates the existing archive only, with no rebuild after attestation. It does not run the whole test/lint/build pipeline. Do not forge a marker; a missing marker fails closed. Expanded human coverage remains blocked on Task 16B, even if the existing marker schema validates.

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
