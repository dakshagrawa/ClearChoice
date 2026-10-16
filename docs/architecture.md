# ClearChoice 1.0.0-rc.2 architecture

This is the unreleased `1.0.0-rc.2` production release candidate candidate, not release-ready or published. Notices are advisory-only; false positives and false negatives remain possible. ClearChoice makes no legal, compliance, safety, or deceptive-site conclusion and does not automate purchases, payments, account actions, cancellations, refunds, or form submission. Chrome Web Store review and submission are future separate work, not complete. Production acceptance remains blocked; human QA is stopped. See [production readiness](../production-readiness.md).

## Access and worker boundary

Manual **Analyze** uses temporary `activeTab` access and needs no automatic-scanning opt-in. Required permissions are `activeTab`, `scripting`, and `storage`; `host_permissions` is empty by default. Optional `https://*/*` declares the ability to request access, not broad granted access. **Enable detection for this site** requests one exact HTTPS origin through Chrome on your click. That revocable grant permits automatic observation on supported English consumer checkout pages at that origin. Account, login, payment-sensitive, restricted, and unsupported pages are skipped. No static content scripts run by default; the worker registers exact-origin scripts after permission checks.

The Manifest V3 worker serializes store mutations and checks strict popup message schemas. Local/session storage access is restricted to `TRUSTED_CONTEXTS`; content scripts cannot read the store directly.

Both submission paths validate top-frame sender identity, document ID, and matching origin. Automatic submissions require the enabled grant generation, live optional permission, and a document challenge, rechecked at the queued write boundary. Manual submissions instead require the pending scan nonce, document/request identity, matching origin, and current active-tab authorization, rechecked before writing; they need no automatic grant.

A matching payload with the same `requestId` replays the prior outcome without another write or timestamp update, subject to authorization rechecks. A mismatched payload with that request ID is a collision and is rejected. Manual Analyze checks the current active tab around injection and targets the returned document ID. Screen DTOs are screened again at the worker boundary; dismissal state is requested through the worker, not direct content storage access.

## Local store and review

All page data stays local. There is no telemetry, accounts, or uploads, backend, sync, remote configuration, or cloud guide service. Analysis excludes typed input, textarea, select, and contenteditable values. A sensitive-looking static context or finding candidate is discarded whole, not redacted and retained. Screening rejects email, payment-card/PAN/masked-card, account/bank/routing-number, CVV, and security-code patterns.

Finding transport carries a privacy-screened excerpt, kind/reason, opaque fingerprint, and occurrence ordinal, plus version, request, and authorization metadata. The worker derives the canonical origin from validated sender context; the worker owns record IDs, first/latest-seen timestamps, and review status. The popup receives screened record fields (ID, canonical origin, kind/reason, excerpt, first/latest-seen timestamps, and review status) without the fingerprint or ordinal. There are no raw URL paths, queries, selectors, HTML, or form values in those messages or local records.

The worker stores at most 500 retained observations in `chrome.storage.local`. Retention choices are 7/30/90/Never days, with 30 days by default. Expiry uses the UTC cutoff and `latestSeen`; Never disables age expiry, not the cap. Confirmed subscriptions stay until you delete them, independently of observation expiry. Settings, grants, dismissal state, and bounded duplicate receipts also stay local.

Automatic observations enter **Needs review**; ClearChoice never automatically confirms a subscription. Automatic observation and **Mark reviewed** do not confirm or create a subscription. You can create, read, edit, and delete local confirmed subscriptions manually. **Review as subscription** opens a draft from your own source finding ID; ambiguous values remain blank. **Save subscription** explicitly confirms the observation and creates a local subscription. Duplicate source-finding protection and refresh invalidation prevent stale review submissions. Merchant, amount, currency, cadence, and optional notes are normalized and screened user-entered fields, not account or payment details. Do not enter identifying, account, or payment information. If a manual Create acknowledgement is lost, inspect the list before retrying: a retry can create a duplicate.

## Panels and guide navigation

Automatic panels appear only after an accepted worker acknowledgement for a positive finding. Zero findings and unsupported pages stay quiet on-page; badge/popup status carries the outcome. Manual zero-findings analysis also leaves no empty findings panel or Cancellation Help footer. Analyze and Restore do not change checkout controls or submit forms.

**Cancellation Help** runs only when you click it and only from a retained, unexpired source observation's canonical origin. The bundled catalog contains four exact Netflix/Spotify origins with official guides; a known-origin fallback can show the source origin instead. A manually entered merchant name never selects a provider. Expired or deleted source observations supply no link. A second HTTPS anchor click makes the browser navigate to the provider article or known source origin; this user-initiated browser navigation is not an extension service upload. The extension does not cancel anything. Deleting a local subscription does not cancel billing.

Catalog metadata was reviewed September 29, 2026; official articles were rechecked September 30 in Task 14. Provider instructions can change. The catalog is bundled, not fetched from a server.

## Residual risks

Browser permission, focus, revocation, registration, and storage checks are not atomic with the final write. A switch or revocation after the last check can remain a race. Revocation invalidates the generation and independently unregisters the script, with best-effort badge/panel cleanup. If storage and unregister both fail, durable cleanup cannot be guaranteed across worker/browser restart. Remove the site's extension access in Chrome Settings before restarting; in-memory denial alone is not durable. Corrupt grant storage triggers best-effort cleanup of ClearChoice-owned scripts, but browser failures can block it.

Identical findings reordered on a page can change ordinal-based identity. Sensitive-text screening is conservative, not proof that all sensitive content is detectable. The emitted-asset network policy is a static check, not runtime network proof. Explicit provider anchors are a narrow user-navigation exception, not permission for extension uploads or remote executable code. A hostile page controls its own DOM; the extension owns only its panel.

See [release gates](beta-release-checklist.md).
