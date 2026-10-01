# ClearChoice 0.4.0-beta.1 private-beta scope

This is the unreleased `0.4.0-beta.1` private opt-in beta candidate, not release-ready or published. Notices are advisory-only; false positives and false negatives remain possible. ClearChoice makes no legal, compliance, safety, or deceptive-site conclusion and does not automate purchases, payments, account actions, cancellations, refunds, or form submission. Chrome Web Store review and submission are future separate work, not complete.

## Supported behavior

Manual **Analyze this tab** uses temporary `activeTab` access and needs no automatic-scanning opt-in. Required permissions are `activeTab`, `scripting`, and `storage`; `host_permissions` is empty by default. Optional `https://*/*` declares the ability to request access, not broad granted access. **Enable on this site** requests one exact HTTPS origin through Chrome on your click. That revocable grant permits automatic observation on supported English consumer checkout pages at that origin. Account, login, payment-sensitive, restricted, and unsupported pages are skipped. No static content scripts run by default; the worker registers exact-origin scripts after permission checks.

Automatic observations enter **Needs review**; ClearChoice never automatically confirms a subscription. Explicit finding confirmation is separate from saving a subscription. You can create, read, edit, and delete local confirmed subscriptions manually. Review opens a draft from your own source finding ID; ambiguous values remain blank. Choose **Save** explicitly. Duplicate source-finding protection and refresh invalidation prevent stale review submissions. Merchant, amount, currency, cadence, and optional notes are normalized and screened user-entered fields, not account or payment details. Do not enter identifying, account, or payment information. If a manual Create acknowledgement is lost, inspect the list before retrying: a retry can create a duplicate.

Automatic panels appear only after an accepted worker acknowledgement for a positive finding. Zero findings and unsupported pages stay quiet on-page; badge/popup status carries the outcome. Manual zero-findings analysis also leaves no empty findings panel or Cancellation Help footer. Analyze and Restore do not change checkout controls or submit forms.

## Local data and guides

All page data stays local. There is no telemetry, accounts, or uploads, backend, sync, remote configuration, or cloud guide service. Analysis excludes typed input, textarea, select, and contenteditable values. A sensitive-looking static context or finding candidate is discarded whole, not redacted and retained. Screening rejects email, payment-card/PAN/masked-card, account/bank/routing-number, CVV, and security-code patterns. Only privacy-screened transport and screen DTOs (data transfer objects) leave the page: a safe excerpt, canonical origin, finding type/reason, first/latest-seen timestamps, and review status. There are no raw URL paths, queries, selectors, HTML, or form values in those messages or local records.

The worker stores at most 500 retained observations in `chrome.storage.local`. Retention choices are 7/30/90/Never days, with 30 days by default. Expiry uses the UTC cutoff and `latestSeen`; Never disables age expiry, not the cap. Confirmed subscriptions stay until you delete them, independently of observation expiry. Settings, grants, dismissal state, and bounded duplicate receipts also stay local.

**Cancellation Help** runs only when you click it and only from a retained, unexpired source observation's canonical origin. The bundled catalog contains four exact Netflix/Spotify origins with official guides; a known-origin fallback can show the source origin instead. A manually entered merchant name never selects a provider. Expired or deleted source observations supply no link. A second HTTPS anchor click makes the browser navigate to the provider article or known source origin; this user-initiated browser navigation is not an extension service upload. The extension does not cancel anything. Deleting a local subscription does not cancel billing.

Catalog metadata was reviewed September 29, 2026; official articles were rechecked September 30 in Task 14. Provider instructions can change. The catalog is bundled, not fetched from a server.

## Exclusions and release status

Task 16A serialization work at `18de837` was quality-approved in the recovered review transcript `deleg_db6fb112`. Task 16B expanded human protocol and native workflow remain pending. The existing manual runner/protocol must not be treated as completed coverage for opt-in, revoke, retention, subscription CRUD, and guides. Task 15 actual-Chrome opt-in permission-request diagnosis is not passing; full E2E success is not claimed. Final human QA, full negative audit, passing beta gate, and actual final-tag CI proof are not complete.

This scope excludes browser-store publication, real-account checkout testing, server guide updates, telemetry, remote code, and billing automation. The Linux human-marker gate does not imply macOS/Windows QA support.

v0.1.0 and v0.2.0 are archived mock-only localhost fixture prototypes, not beta support: <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.1.0> and <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0>. The historical v0.2.0 release evidence remains in [release-checklist.md](release-checklist.md); the future beta gates are tracked in [beta-release-checklist.md](beta-release-checklist.md).
