# ClearChoice 0.4.0-beta.1 candidate evidence

This is the unreleased `0.4.0-beta.1` private opt-in beta candidate, not release-ready or published. Notices are advisory-only; false positives and false negatives remain possible. ClearChoice makes no legal, compliance, safety, or deceptive-site conclusion and does not automate purchases, payments, account actions, cancellations, refunds, or form submission. Chrome Web Store review and submission are future separate work, not complete.

Chrome numeric `version` is `0.4.0`; `version_name` is `0.4.0-beta.1`. Archive: `ClearChoice-v0.4.0-beta.1-unpacked.zip`.

## Verified snapshot and limits

At source commit `4eb37bcc6591a753f527cab82476c31c2b7021e2`, the coordinating review recorded passing full units, lint, TypeScript, build/package checks and a focused native subscription CRUD E2E. Those results predate this documentation edit and are not final-candidate proof. They do not establish full E2E, genuine Chrome consent, human QA, a release gate, or final-tag CI. Moving test counts are intentionally omitted.

Task 16A serialization work at `18de837` was quality-approved in the recovered review transcript `deleg_db6fb112`. Task 16B expanded human protocol and native workflow remain pending. The existing manual runner/protocol must not be treated as completed coverage for opt-in, revoke, retention, subscription CRUD, and guides. Task 15 actual-Chrome opt-in permission-request diagnosis is not passing; full E2E success is not claimed. Final human QA, full negative audit, passing beta gate, and actual final-tag CI proof are not complete.

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

Loopback mock fixtures cannot use **Enable on this site**: `isGrantOrigin` rejects IP addresses and localhost. Reserved `.test` browser harness origins map locally with pregranted Chrome permissions. They are automated setup, not genuine human consent. Do not use live account or payment checkouts to work around fixtures.

## Human gate

The exact-artifact marker requires local human self-attestation bound to the exact commit, packaged manifest SHA-256, and complete ZIP SHA-256, with every required predicate passing. Verify the actual marker schema against the latest runner and validator at integration; Task 16B expands the schema and remains pending review. The Linux-only marker must be a regular external file; terminal symlinks are rejected with `O_NOFOLLOW`, and `/proc/self/fd` binds the opened descriptor outside the repository. It is not cryptographic proof of a gesture. `npm run check:beta` validates the existing archive only, with no rebuild after attestation. It does not run the whole test/lint/build pipeline. Do not forge a marker; a missing marker fails closed. Expanded human coverage remains blocked on Task 16B, even if the existing marker schema validates.

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
