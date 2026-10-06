# ClearChoice 0.4.0-beta.1 candidate evidence

This is the unreleased `0.4.0-beta.1` private opt-in beta candidate, not release-ready or published. Notices are advisory-only; false positives and false negatives remain possible. ClearChoice makes no legal, compliance, safety, or deceptive-site conclusion and does not automate purchases, payments, account actions, cancellations, refunds, or form submission. Chrome Web Store review and submission are future separate work, not complete.

Chrome numeric `version` is `0.4.0`; `version_name` is `0.4.0-beta.1`. Archive: `ClearChoice-v0.4.0-beta.1-unpacked.zip`.

## Verified snapshot and limits

At source commit `4eb37bcc6591a753f527cab82476c31c2b7021e2`, the coordinating review recorded passing full units, lint, TypeScript, build/package checks and a focused native subscription CRUD E2E. Those results predate this documentation edit and are not final-candidate proof. They do not establish full E2E, genuine Chrome consent, human QA, a release gate, or final-tag CI. Moving test counts are intentionally omitted.

Task 16A exact-archive serialization is integrated and quality-approved. Task 16B final mixed-evidence runner wiring is implemented and independently approved; genuine human QA remains pending. The permission hang was resolved with the exact mock-port seed. The restart harness was corrected to install once rather than reinstall on launch; packaged detector and record persistence now pass genuine browser restart checks. The last integrated committed-source run at `f307973691ea91e984efc7b2ad5111a3295b4452` passed 768 units and 15 browser tests, lint, TypeScript, build/package policy, and both dependency audits. Two additional real-browser in-flight-revoke/quota-retry tests independently passed and were quality-approved before commit `a1a30a5`. Native programmatic checks do not establish human toolbar access or permission consent. Final runner working-tree verification passed 771 units, 17 browser tests, lint, TypeScript, build/package policy and both audits (zero vulnerabilities). These results are automated evidence, not final-candidate proof of human gestures. Final human QA, exact-artifact beta gate, publication and final-tag CI proof are not complete.

## Candidate checks to repeat

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

## Human gate

The exact-artifact marker requires local human self-attestation bound to the exact commit, packaged manifest SHA-256, and complete ZIP SHA-256, with every required predicate passing. The actual marker schema is 6; Task 16B human execution remains pending. The Linux-only marker must be a regular external file; terminal symlinks are rejected with `O_NOFOLLOW`, and `/proc/self/fd` binds the opened descriptor outside the repository. It is not cryptographic proof of a gesture. `npm run check:beta` validates the existing archive only, with no rebuild after attestation. It does not run the whole test/lint/build pipeline. Do not forge a marker; a missing marker fails closed. Schema 6 preserves the approved synthetic-expiry and human public-article/packaged-catalog labels and requires `humanReportedDenial-correlated-real-request-and-verified-isolation-not-browserObserved`. The human reports actual Deny through `DENIED`; the runner verifies a fresh exact B Enable/request and isolation without pinning the popup or claiming a Deny callback. Schema 5 and older markers fail closed. This does not retroactively pass any run or claim elapsed-time/provider-navigation coverage. See [the approved QA evidence decision](beta-test-protocol.md). Genuine human execution remains mandatory.

## 0.3.0-beta.1 historical evidence

Published `v0.3.0-beta.1` remains immutable at `9ff1b37a3ca8f1508d9cc4eb47e20669fcf65434`. The following preserved candidate notes describe the old 0.3 workflow, not the current beta or new proof:

# ClearChoice 0.3.0-beta.1 beta-candidate evidence

This is an untagged private QA candidate, not a human-QA result, `check:beta` success, release, tag, or Chrome Web Store submission. It is awaiting a real human toolbar-click/popup-Analyze activeTab validation marker, saved outside the repository, for the final candidate commit and source-manifest SHA-256.

## Automated candidate checks

Run from a clean checkout:

```sh
npm ci
npm test -- --run
npm run lint
npm run build
npm run e2e
npm run package:unpacked
npm run verify:archive
npm run check:release
npm audit --omit=dev
```

The candidate archive name is derived from the `package.json` semantic version by `scripts/release-artifact.mjs`: `ClearChoice-v0.3.0-beta.1-unpacked.zip`. Chrome requires a numeric manifest `version`, so source, generated `dist`, and ZIP manifests use Chrome numeric `version` `0.3.0`; their `version_name` is `0.3.0-beta.1`, exactly matching `package.json` for the displayed beta identity. Package verification preserves the exact ordered `activeTab`, `scripting`, `storage` policy, empty host permissions, and local-only/privacy checks.

## Remaining manual gate

A real human must use visible Linux Chromium against the documented clean and dynamic fixtures, invoke Analyze with the toolbar-click/popup flow, verify actual-panel keyboard behavior (Tab reaches Dismiss; Escape closes only the ClearChoice panel), and complete the dynamic sequence. Only then may the human deliberately create the external marker bound to the final commit and source manifest SHA-256. Do not create or forge a marker for automation. Until then, `npm run check:beta` must fail closed solely because `CLEARCHOICE_ACTIVE_TAB_QA_MARKER` is absent.

Historical v0.2.0 artifact evidence remains separately labeled in [test-evidence.md](test-evidence.md).

Historical notes that say source-manifest hash or automated gate rebuild are superseded for the current candidate by packaged-manifest and complete-ZIP binding. Historical release/tag evidence is not overwritten.
