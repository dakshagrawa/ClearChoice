# ClearChoice 1.0.0-rc.1 production acceptance checklist

This is the unreleased `1.0.0-rc.1` production release candidate, not release-ready or published. Chrome numeric version is `1.0.0`. Production acceptance remains blocked; human QA is stopped. Existing privacy and permission requirements and all uncompleted gates below apply to promotion. See [production readiness](../production-readiness.md).

The beta identity and execution results below are historical baseline evidence.

# ClearChoice 0.4.0-beta.1 release checklist

This is the unreleased `0.4.0-beta.1` private opt-in beta candidate, not release-ready or published. Notices are advisory-only; false positives and false negatives remain possible. ClearChoice makes no legal, compliance, safety, or deceptive-site conclusion and does not automate purchases, payments, account actions, cancellations, refunds, or form submission. Chrome Web Store review and submission are future separate work, not complete.

Chrome numeric `version` is `0.4.0`; `version_name` is `0.4.0-beta.1`. The candidate archive is `ClearChoice-v0.4.0-beta.1-unpacked.zip`.

Task 16A exact-archive serialization is integrated and quality-approved. Task 16B final mixed-evidence runner wiring is implemented and independently approved; genuine human QA remains pending. The permission hang was resolved with the exact mock-port seed. The restart harness was corrected to install once rather than reinstall on launch; packaged detector and record persistence now pass genuine browser restart checks. The last integrated committed-source run at `f307973691ea91e984efc7b2ad5111a3295b4452` passed 768 units and 15 browser tests, lint, TypeScript, build/package policy, and both dependency audits. Two additional real-browser in-flight-revoke/quota-retry tests independently passed and were quality-approved before commit `a1a30a5`. Native programmatic checks do not establish human toolbar access or permission consent. Final runner working-tree verification passed 771 units, 17 browser tests, lint, TypeScript, build/package policy and both audits (zero vulnerabilities). These results are automated evidence, not final-candidate proof of human gestures. Final human QA, exact-artifact beta gate, publication and final-tag CI proof are not complete.

## Required behavior

Manual **Analyze** uses temporary `activeTab` access and needs no automatic-scanning opt-in. Required permissions are `activeTab`, `scripting`, and `storage`; `host_permissions` is empty by default. Optional `https://*/*` declares the ability to request access, not broad granted access. **Enable detection for this site** requests one exact HTTPS origin through Chrome on your click. That revocable grant permits automatic observation on supported English consumer checkout pages at that origin. Account, login, payment-sensitive, restricted, and unsupported pages are skipped. No static content scripts run by default; the worker registers exact-origin scripts after permission checks.

All page data stays local. There is no telemetry, accounts, or uploads, backend, sync, remote configuration, or cloud guide service. Analysis excludes typed input, textarea, select, and contenteditable values. A sensitive-looking static context or finding candidate is discarded whole, not redacted and retained. Screening rejects email, payment-card/PAN/masked-card, account/bank/routing-number, CVV, and security-code patterns.

Finding transport carries a privacy-screened excerpt, kind/reason, opaque fingerprint, and occurrence ordinal, plus version, request, and authorization metadata. The worker derives the canonical origin from validated sender context; the worker owns record IDs, first/latest-seen timestamps, and review status. The popup receives screened record fields (ID, canonical origin, kind/reason, excerpt, first/latest-seen timestamps, and review status) without the fingerprint or ordinal. There are no raw URL paths, queries, selectors, HTML, or form values in those messages or local records.

The worker stores at most 500 retained observations in `chrome.storage.local`. Retention choices are 7/30/90/Never days, with 30 days by default. Expiry uses the UTC cutoff and `latestSeen`; Never disables age expiry, not the cap. Confirmed subscriptions stay until you delete them, independently of observation expiry. Settings, grants, dismissal state, and bounded duplicate receipts also stay local.

Automatic observations enter **Needs review**; ClearChoice never automatically confirms a subscription. Automatic observation and **Mark reviewed** do not confirm or create a subscription. You can create, read, edit, and delete local confirmed subscriptions manually. **Review as subscription** opens a draft from your own source finding ID; ambiguous values remain blank. **Save subscription** explicitly confirms the observation and creates a local subscription. Duplicate source-finding protection and refresh invalidation prevent stale review submissions. Merchant, amount, currency, cadence, and optional notes are normalized and screened user-entered fields, not account or payment details. Do not enter identifying, account, or payment information. If a manual Create acknowledgement is lost, inspect the list before retrying: a retry can create a duplicate.

Automatic panels appear only after an accepted worker acknowledgement for a positive finding. Zero findings and unsupported pages stay quiet on-page; badge/popup status carries the outcome. Manual zero-findings analysis also leaves no empty findings panel or Cancellation Help footer. Analyze and Restore do not change checkout controls or submit forms.

**Cancellation Help** runs only when you click it and only from a retained, unexpired source observation's canonical origin. The bundled catalog contains four exact Netflix/Spotify origins with official guides; a known-origin fallback can show the source origin instead. A manually entered merchant name never selects a provider. Expired or deleted source observations supply no link. A second HTTPS anchor click makes the browser navigate to the provider article or known source origin; this user-initiated browser navigation is not an extension service upload. The extension does not cancel anything. Deleting a local subscription does not cancel billing.

Catalog metadata was reviewed September 29, 2026; official articles were rechecked September 30 in Task 14. Provider instructions can change. The catalog is bundled, not fetched from a server.

## Uncompleted gates

- [x] Integrate quality-approved Task 16A serialization; final archive binding still requires recheck
- [x] Implement and independently review historical Task 16B mixed-evidence runner and schema 5
- [ ] Review and integrate schema 7 human re-enable/action-and-state contract with correlated humanReportedDenial; no prior run is retrospectively passed
- [ ] Complete genuine human opt-in/revoke, retention, CRUD, guide, keyboard, and integrity QA
- [x] Resolve harness reinstall/restart loss and verify native persistence
- [x] Rerun full native E2E after final runner integration: 17/17 passed
- [ ] Run bounded units, lint, TypeScript, clean build/package checks, and full negative audit on final candidate
- [ ] Obtain deliberate human evidence and validate existing archive without rebuilding
- [ ] Record final-tag CI proof only after all private release gates pass

The exact-artifact marker requires local human self-attestation bound to the exact commit, packaged manifest SHA-256, and complete ZIP SHA-256, with every required predicate passing. The actual marker schema is 7; Task 16B human execution remains pending. The Linux-only marker must be a regular external file; terminal symlinks are rejected with `O_NOFOLLOW`, and `/proc/self/fd` binds the opened descriptor outside the repository. It is not cryptographic proof of a gesture. `npm run check:beta` validates the existing archive only, with no rebuild after attestation. It does not run the whole test/lint/build pipeline. Do not forge a marker; a missing marker fails closed. Schema 7 preserves the approved synthetic-expiry, human public-article/packaged-catalog and `humanReportedDenial-correlated-real-request-and-verified-isolation-not-browserObserved` evidence labels and requires `reenableEvidence: human-reenable-action-and-verified-state-no-new-dialog-required`. Step 13 still requires genuine initial Chrome Allow. Step 17a requires the human Enable click and exact verified state with `REENABLE_CONFIRMED`; Allow is required only if Chrome actually shows another dialog. Chrome documents that removed optional permission is usually restored without prompting. Chrome Settings exact-site removal remains mandatory and unchanged. Human `DENIED` is correlated with a fresh trusted B Enable/request and durable isolation, not a browser-observed Deny callback. It does not claim elapsed-time or provider-navigation coverage, and schema 6 or older markers are rejected. Prior failed runs remain failed; diagnostics are not human passes. See the approved decision and limitations in [the QA protocol](beta-test-protocol.md). Genuine human execution remains mandatory.

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

## Historical prototypes

**v0.1.0 and v0.2.0 are archived mock-only localhost fixture prototypes, not beta support.** Their preserved private releases are <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.1.0> and <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0>. Neither archive is lost, replaced, ordinary-site support, production-ready, or beta-eligible.
