# ClearChoice Opt-In Subscriptions Private-Beta Implementation Plan

> **For Hermes:** Use `subagent-driven-development` and `test-driven-development` task-by-task. Save this plan to both `.omh/plans/ralplan-clearchoice-opt-in-subscriptions.md` and `docs/plans/ralplan-clearchoice-opt-in-subscriptions.md` before implementation. This planning pass makes **no repository edits**.


**Consensus record:** OMH Ralplan ran three rounds (Planner → Architect → Critic, then two parallel re-reviews). Round 1: Planner APPROVE, Architect/Critic REQUEST_CHANGES (storage ownership, races, exact QA). Round 2: both REQUEST_CHANGES (missing excerpt, subscription CRUD and cancellation catalog). Round 3: both REQUEST_CHANGES solely on artifact provenance; Critic also found a replay/rescan assertion error. The parent incorporated those two corrections below. **No unanimous subagent APPROVE was reached within the three-round cap.** These resolved items are a mandatory pre-flight review gate for implementation, not a claim of subagent consensus.

**Revision summary:** Worker-only trusted storage, strict screened excerpt, explicit subscription CRUD and official-help catalog, per-site grant/revocation, bounded retention, packaged Chromium tests, and exact-release-artifact human QA replaced the initial activeTab-only assumptions.

**Goal:** Deliver a new private beta with manually managed subscriptions, user-confirmed checkout suggestions, per-site opt-in detection, locally retained review findings, and reviewed cancellation guidance—without accounts, payment or cancellation actions, a server, or sync.

**Architecture:** Preserve the existing local detector and extension-owned panel. Add an MV3 service worker as the sole owner of opt-in grants, review-history mutations, retention, and badge state. The content script screens findings before sending a strictly bounded DTO; the worker validates it again and writes receipt and history together. Confirmed subscriptions are a separate user-owned collection, never inferred from detection.

**Tech stack:** TypeScript, Chromium MV3, Vite, Vitest/JSDOM, Playwright, Node 24. Baseline is clean `master` at `6b2d000`; the published old beta is immutable. Produce a **new** private-beta identity and artifact, not an overwrite.

---

## Contract and decisions to implement

- **Manual subscriptions:** `id`, `merchant`, decimal `amount` as a validated string, ISO `currency`, `cadence` (`weekly | monthly | quarterly | yearly | custom` with a required custom description), optional ISO calendar `nextBillingDate`, optional `notes`, `createdAt`, `updatedAt`, and optional `sourceFindingId`. Full create/read/update/delete. No payment credentials, account identifiers, or automatic renewal-date calculations. Confirming a suggestion opens an editable form; nothing enters this collection until the user presses **Save subscription**.
- **Review history:** separate `FindingRecord` with `id`, canonical HTTPS `origin` (localhost HTTP only for fixtures), `kind`, `reason`, `screenedExcerpt`, `opaqueFingerprint`, `ordinal`, `firstSeen`, `latestSeen`, and `status: 'needs-review' | 'reviewed'`. Every eligible **distinct** finding is saved automatically as `needs-review`; repeats update `latestSeen` without resetting `firstSeen` or a reviewed status. A fresh fingerprint/ordinal is a new record. A receipt replay with the same request ID returns the prior outcome without updating observation timestamps; only a new scan/request advances `latestSeen`. No URL path/query, selector, raw evidence, page HTML, or typed field data is stored.
- **Exact content→worker finding DTO:** `{version: 1, requestId, kind, reason, screenedExcerpt, opaqueFingerprint, ordinal}`—no extra keys. `screenedExcerpt` is normalized visible static text, at most 160 characters, and screened **both before and after truncation**; reject the entire candidate on a sensitive match rather than redact. Fingerprint is an opaque digest of kind, reason, and normalized screened excerpt; ordinal is the occurrence number among equal fingerprints in DOM order. It distinguishes simultaneously repeated labels, not a stable DOM identity across reorderings. Do not use `Finding.id` or selector as persistent identity. The envelope/challenge supplies generation and sender context, not page evidence. The worker accepts only valid combinations of `kind`/`reason`, bounded strings, digest format, positive bounded ordinal, and exact keys; it re-screens the excerpt. Manual Analyze's popup response remains **status and count only**; a separate review-list read may display stored screened excerpts.
- **Capacity:** cap a scan at 100 eligible findings and history at 500 records. On overflow or storage quota/error, report an explicit local error and commit **no partial scan**; never silently truncate, evict, or claim saved. Retention is default 30 days, user-selectable `7 | 30 | 90 | never`, applied to review history by `latestSeen`; it does not erase manually confirmed subscriptions. “Never” means no age expiry, **not** unlimited capacity.
- **Worker serialization and receipts:** one in-worker mutation queue covers permission/grant state, finding batches, review status, subscription CRUD, and retention changes. For a batch, reload current state, validate all candidates/capacity, and write the new history **and** bounded request receipt in one `chrome.storage.local.set({reviewHistory, receipts})` payload. Receipts map `requestId` to a digest of the validated batch and committed outcome; same ID/same digest returns prior outcome, same ID/different digest rejects. Persist a bounded receipt window (e.g. 500, expired with history policy where safe); if an old receipt is gone, stable finding IDs still make replay an upsert rather than duplicate. Await write before acknowledgement; after worker restart reread storage and retry with the same request ID. A quota failure is an error, not success. Chrome storage is not a cross-process transaction: document that a concurrent external writer or crash at the API boundary is outside the guarantee.
- **Document and permission correlation:** Chrome `tabs.Tab` does **not** provide `documentId`. For manual Analyze, use `scripting.executeScript`’s top-frame `InjectionResult.documentId`, then `tabs.sendMessage(tabId, message, {documentId})`; check active tab before injection and after awaits. For dynamic registered scripts, use `sender.documentId`, `sender.frameId === 0`, `sender.tab.id`, `sender.origin`/validated sender URL origin, and a targeted `tabs.sendMessage(..., {documentId: sender.documentId})` challenge before accepting a batch. Recheck the current permission, per-site enabled grant, and in-memory/storage generation immediately before commit. Revoke increments generation, unregisters the site script, clears its badge, and sends a targeted disable/remove-panel message; an old generation fails. There remains a **non-atomic navigation/revoke race** between checks and browser operations; never promise atomic prevention. Fail closed on missing document ID, mismatched challenge, failed permission check, or ambiguous sender.
- **Opt-in:** no global host access. Request optional origin permission only on a user click for one HTTPS site; fixture localhost may be explicitly allowed in tests. Register only that site's content script after a successful permission grant, reconcile registrations and `chrome.permissions.contains` on worker startup, and handle permission removal. Denial leaves no enabled grant, registration, or panel. Existing `activeTab` manual Analyze remains available without opt-in.
- **Presentation:** automatic panel only for supported checkout context **with one or more findings**. Zero findings means no panel; popup and badge communicate status instead. A bounded/debounced observer handles checkout appearance, findings changes, and SPA exit; exit removes the panel immediately, updates badge, and does not erase history. Analyze/Restore remain deliberate popup actions. A suggestion is not a confirmed subscription.

## Exact-artifact QA and release sequencing (mandatory correction from round 3)

The current ZIP packaging is **not byte-reproducible**: two builds of unchanged `0.3.0-beta.1` source produced different SHA-256 hashes. Therefore a commit+source-manifest marker alone cannot attest the shipped ZIP.

1. Commit and freeze the final candidate source. From a clean checkout, run `npm ci`, `npm run check:release`, `npm audit`, `npm audit --omit=dev`, and the package verifier's negative tests. Fixes restart the sequence.
2. Build **one final ZIP**, verify its actual `manifest.json` and contents, compute its SHA-256, and copy/extract the same ZIP into the visible Chromium manual-QA profile. Do not run manual QA on a separately rebuilt `dist/`. Record the exact Git commit, SHA-256 of the **manifest inside the ZIP**, and SHA-256 of the complete ZIP in the human QA marker after genuinely completing the opt-in permission/UI/retention/subscription/link checkpoints. Keep the marker external to the repo and retain the existing Linux descriptor-safe file validation.
3. `check:beta` must validate the already-existing immutable candidate ZIP, its contained manifest, the exact commit and marker schema/checkpoints; it **must not run `build`, `package:unpacked`, or overwrite the ZIP after the marker was recorded**. It may run non-mutating checks. Reject absent/old markers, any changed ZIP/hash, changed commit, changed packaged manifest, or unchecked checkpoint. On failure, stop; rebuild then repeat the human QA if the artifact changes.
4. Publish only the byte-identical ZIP whose hash matched the marker, then download the private GitHub release asset and compare SHA-256 with the verified local ZIP. Preserve the old beta tag and releases. No false claim that marker proves the user gesture cryptographically; it is deliberate self-attestation against the reviewed archive.

## Task protocol

For **every code task below**, the delegate first adds the named single-behavior test, runs the stated focused command and records a **RED failure attributable to missing behavior** (not a compile error), implements the smallest vertical slice, reruns for **GREEN**, then runs `npm test -- --run`, `npm run lint`, and `npx tsc --noEmit` before a focused commit. Repeat RED→GREEN separately for each listed edge case; do not write an entire suite before implementation. Node 24 and `npm ci` are prerequisites. Tests must assert behavior and storage effects, not merely mock calls.

### Task 1 — Establish the new package and manifest contract

**Files:** `package.json`, `manifest.json`, `scripts/verify-package.mjs`, `tests/beta-manifest-policy.test.mjs`, `tests/package-contract.test.mjs`, `vite.config.ts`.

**RED example:** assert the new manifest has an MV3 background service worker, optional per-origin permission support, **no** required host origins or static global content script, and that a forbidden `<all_urls>` or unrelated origin still fails. Run `node --test tests/beta-manifest-policy.test.mjs tests/package-contract.test.mjs`; expect the worker/optional permission assertion to fail on `6b2d000`.

**GREEN:** choose a new matching numeric `version`/`version_name`/package semver; add `background.service_worker`, `optional_host_permissions` limited to a policy permitting user-requested HTTPS origins (and narrowly scoped fixture localhost if needed), and emitted `worker.js`. Update the manifest verifier's exact allowlist rather than disabling safety scans. Keep `activeTab`, `scripting`, `storage`, empty required `host_permissions`, and no network API. Assert `npm run build` emits worker, popup, and content assets and `npm run verify:package` passes.

**Acceptance:** old package/version is untouched; unsupported permissions and remote runtime patterns still fail. **Depends on:** baseline only.

### Task 2 — Define strict wire schemas and screened DTO

**Files:** `src/shared/messages.ts`, `src/shared/messages.test.ts`, `src/core/sensitive.ts`, `src/core/sensitive.test.ts`, new `src/shared/finding-dto.ts`, `src/shared/finding-dto.test.ts`.

**RED example:** `expect(toFindingDto(rawFinding, 'req-1', 1)).toBeNull()` when evidence includes `card •••• 1234`; assert a valid 160-character excerpt validates, a 161-character excerpt or extra `selector`, `evidence`, or `url` key rejects, and post-truncation sensitive text rejects. Run `npm test -- --run src/shared/finding-dto.test.ts`; expect the missing DTO implementation to fail.

**GREEN:** implement exact-version, exact-key validation and normalized static-text screening. Keep transport request/challenge and list-response types distinct from `AnalyzeResponse`; preserve manual response's count/status-only contract. Tests inspect serialized messages for prohibited keys. **Depends on:** 1.

### Task 3 — Stable within-scan multiplicity and bounded batch

**Files:** `src/content/index.ts`, `src/core/dedupe.ts`, new `src/content/candidates.ts`, `src/content/index.test.ts`, `src/content/candidates.test.ts`.

**RED example:** two equal visible paid options produce equal opaque fingerprints with ordinals `1` and `2`; a repeat scan produces the same pair; 101 eligible findings returns an explicit overflow error without a partial batch. Run `npm test -- --run src/content/candidates.test.ts`.

**GREEN:** sort by DOM order, screen before hashing, assign ordinal per fingerprint, and produce one request ID per scan with the same ID on retry. Keep raw `Finding.evidence` and selectors page-local for panel highlighting only. Assert excluded form/editable and sensitive candidates never enter the batch. **Depends on:** 2.

### Task 4 — Validate persisted models and migrations

**Files:** new `src/shared/models.ts`, `src/shared/models.test.ts`, `src/shared/storage.ts`, `src/shared/storage.test.ts`.

**RED example:** a malformed amount, currency, date, oversized notes, or unexpected persisted key fails validation; a valid manual subscription round-trips with `sourceFindingId` absent. Run `npm test -- --run src/shared/models.test.ts`.

**GREEN:** define bounded subscription and review schemas, normalized merchant and currency, exact calendar-date validation, IDs and timestamps, and versioned local storage defaults. Migrate existing `dismissed` preference without turning it into a subscription or review record; fail safely on corrupt new records rather than rendering raw values. **Depends on:** 2.

### Task 5 — Atomic-payload receipt/upsert queue

**Files:** new `src/worker/store.ts`, `src/worker/store.test.ts`, `src/shared/storage.ts`.

**RED example:** simulate an acknowledgement loss after a successful storage write and retry the **same request ID**: assert one record, **unchanged `firstSeen` and `latestSeen`**, and the same receipt result with no second mutation. Then run a genuinely **new scan with a new request ID** and assert `latestSeen` advances; a changed payload under the original request ID rejects. Simulate quota rejection and assert neither success nor partial history. Run `npm test -- --run src/worker/store.test.ts`.

**GREEN:** single serialized mutation queue; re-read state inside queued operations, derive stable ID from canonical origin+fingerprint+ordinal, validate whole batch and 500-record cap before the one `{reviewHistory, receipts}` write. Keep reviewed state on rescan. Receipt digest includes canonical origin and all validated DTO values in order. Test worker-store recreation from the same fake storage. **Depends on:** 3–4.

### Task 6 — Retention and review-status operations

**Files:** `src/worker/store.ts`, `src/worker/store.test.ts`, `src/shared/models.ts`.

**RED example:** default 30-day expiry removes an old `latestSeen` record, choosing 7/90 changes the cutoff, `never` retains it, and confirmed subscriptions survive every setting. Marking reviewed followed by rescan remains reviewed. Run `npm test -- --run src/worker/store.test.ts -t 'retention|reviewed'`.

**GREEN:** perform retention in the same queue, on startup/read/mutation as appropriate; use an injectable clock and defined inclusive cutoff. Keep capacity errors explicit even with `never`. **Depends on:** 5.

### Task 7 — Manual Analyze document-targeted worker bridge

**Files:** `src/shared/tab-analysis.ts`, `src/shared/tab-analysis.test.ts`, new `src/worker/index.ts`, `src/worker/index.test.ts`, `src/shared/messages.ts`.

**RED example:** injection returns a top-frame `documentId`; assert message targets that ID, not a guessed `tab.documentId`, and navigation/tab-focus changes yield an error without accepting a finding. Run `npm test -- --run src/shared/tab-analysis.test.ts src/worker/index.test.ts`.

**GREEN:** route the manual command through worker coordination; use top-frame `InjectionResult.documentId`, active-tab checks, and document-targeted Analyze. Worker challenge verifies sender tab/frame/document before accepting its batch; popup receives only count/status/error. Preserve restricted-page behavior. Mark the residual check-to-send race in code documentation. **Depends on:** 5.

### Task 8 — Per-site grant and registration lifecycle

**Files:** new `src/worker/grants.ts`, `src/worker/grants.test.ts`, `src/worker/index.ts`, `manifest.json`.

**RED example:** denied permission produces no saved grant or registration; grant A does not enable B; removal increments generation, unregisters A, and rejects an in-flight old-generation batch. Run `npm test -- --run src/worker/grants.test.ts`.

**GREEN:** normalize exact site origin, request only via user gesture, persist enabled/grant generation through the queue, register site-scoped script, reconcile permissions and registrations on startup, and respond to `permissions.onRemoved`. Explicitly handle permission success followed by registration/storage failure by disabling and reporting error; no scanning until registration and grant agree. **Depends on:** 1, 5, 7.

### Task 9 — Dynamic sender challenge and fail-closed persistence

**Files:** `src/worker/index.ts`, `src/worker/index.test.ts`, `src/worker/grants.ts`, `src/shared/messages.ts`.

**RED example:** forged DTO with valid-looking origin but wrong `sender.documentId`, subframe sender, stale generation, permission revoked during challenge, or failed targeted response cannot create history. Run `npm test -- --run src/worker/index.test.ts -t 'challenge|stale|sender'`.

**GREEN:** challenge `sender.documentId` using targeted `tabs.sendMessage`; compare nonce, tab/frame/document, canonical sender origin and current grant/generation/permission just before queued write. Do not rely on `tabs.Tab.documentId`. Return explicit retryable failure for transient worker/storage errors; avoid retaining raw payload in logs. **Depends on:** 8.

### Task 10 — Automatic checkout and panel SPA lifecycle

**Files:** `src/content/index.ts`, `src/content/index.test.ts`, `src/content/panel.ts`, `src/content/panel.test.ts`, `fixtures/beta-dynamic-checkout.html`.

**RED example:** on an opted-in supported checkout with no findings, no panel exists; insertion of a finding shows one; SPA replacement with an unsupported context removes it; repeated rerenders never duplicate observers/panels or history; revoke removes it. Run `npm test -- --run src/content/index.test.ts src/content/panel.test.ts`.

**GREEN:** one sentinel/observer per document, debounce bounded scans, ignore extension-owned panel mutations, remove on unsupported/zero/disable, and clean up on navigation/unload. Keep Dismiss scoped to panel visibility, not history deletion. Report scan overflow rather than rendering a misleading partial result. **Depends on:** 3, 8–9.

### Task 11 — Badge and popup opt-in/review controls

**Files:** `src/popup/main.ts`, `src/popup/main.test.ts`, `src/popup/index.html`, `src/worker/index.ts`, `src/worker/index.test.ts`.

**RED example:** popup initially shows site disabled and review count; enabling A requests A only; zero findings leaves no panel but badge/popup shows zero/status; disabling A clears its badge and panel while B remains enabled. Run `npm test -- --run src/popup/main.test.ts src/worker/index.test.ts`.

**GREEN:** user-click Enable/Disable, permission denial/error copy, history “Needs review” count and safe list. Badge is tab-scoped, cleared on unsupported context, SPA exit, navigation and revoke; no page evidence in manual Analyze response. Render excerpts with `textContent`, never HTML injection. **Depends on:** 6, 8–10.

### Task 12 — Manual subscription CRUD

**Files:** new `src/popup/subscriptions.ts`, `src/popup/subscriptions.test.ts`, `src/popup/main.ts`, `src/worker/store.ts`, `src/worker/store.test.ts`.

**RED example:** create, reopen, edit, and delete a subscription; invalid amount/date leaves storage unchanged; cancellation of a delete confirmation leaves it intact. Run `npm test -- --run src/popup/subscriptions.test.ts`.

**GREEN:** editable form for merchant, amount/currency, cadence/custom description, optional next date, and notes; list/detail/edit/delete through queued worker mutations. Avoid `innerHTML` for user content. Show explicit storage errors and verify persistence after worker recreation. **Depends on:** 4–6, 11.

### Task 13 — User-confirmed checkout suggestion

**Files:** `src/popup/main.ts`, `src/popup/main.test.ts`, `src/popup/subscriptions.ts`, `src/worker/store.ts`, `src/worker/store.test.ts`.

**RED example:** detected record alone leaves `subscriptions` empty; clicking “Review as subscription” opens a prefilled but editable form; cancel leaves it empty; only explicit Save creates a confirmed record with `sourceFindingId`. Run `npm test -- --run src/popup/main.test.ts -t 'suggestion|confirm'`.

**GREEN:** prefill only defensible fields; never invent merchant, amount, currency, cadence, or date from ambiguous evidence. Require user completion and validation. A reviewed finding is not itself confirmation. **Depends on:** 11–12.

### Task 14 — Reviewed official cancellation-guide catalog

**Files:** new `src/shared/guide-catalog.ts`, `src/shared/guide-catalog.test.ts`, `src/popup/main.ts`, `src/popup/main.test.ts`, `docs/rule-catalog.md`.

**RED example:** exact Netflix/Spotify canonical origins resolve to an approved HTTPS help article with `lastReviewed`; lookalike domains and unrecognized/manual-only merchants do not resolve; fallback returns **only the known origin**, not an inferred cancellation path or search URL. Run `npm test -- --run src/shared/guide-catalog.test.ts`.

**GREEN:** explicit allowlist entries with source URL, title, domain/origin matching, review date, and a short caveat about third-party billing; render a link only after user click and visibly label it “Official guide (reviewed …)” versus “Visit site” fallback. Verify the primary sources during implementation: [Netflix—How to cancel Netflix](https://help.netflix.com/en/node/407) and [Spotify—How to cancel Premium plans](https://support.spotify.com/us/article/cancel-premium/). Both were retrieved as official help pages during planning, but links and instructions must be rechecked at release. No scraping, auto-navigation, account access, or cancellation action. **Depends on:** 12–13.

### Task 15 — Package-level behavior, accessibility, and adverse-state tests

**Files:** `e2e/clearchoice-extension.spec.ts`, `e2e/payload-panel-accessibility.spec.ts`, new `e2e/opt-in-subscriptions.spec.ts`, `tests/package-contract.test.mjs`, `scripts/verify-package.mjs`, `fixtures/beta-dynamic-checkout.html`.

**RED example:** packaged MV3 test currently cannot enable one site, persist distinct findings, show no zero-finding panel, survive worker restart, or create a subscription only on Save. Run `npm run e2e -- e2e/opt-in-subscriptions.spec.ts`; expect the missing workflow to fail.

**GREEN:** exercise packaged popup/worker/content on controlled fixtures: grant denial, A-vs-B isolation, manual activeTab without opt-in, repeated duplicate and two identical simultaneous findings, SPA exit, revoke during in-flight scan, restart/retry, retention, quota/cap errors, CRUD, keyboard focus and serious/critical Axe checks. Keep fixture-only automation separate from real-site human QA. Update static policy without exempting `worker.js`; verify archive includes it and contains no prohibited network sinks. **Depends on:** 1–14.

### Task 16 — Current docs, release gates, and new private artifact

**Files:** `docs/architecture.md`, `docs/beta-scope.md`, `docs/beta-release-checklist.md`, `docs/beta-test-protocol.md`, `docs/beta-feedback-template.md`, `PRIVACY.md`, `README.md`, `CHANGELOG.md`, `IDEAS.md`, `tests/documentation.test.mjs`, `scripts/check-beta.mjs`, `scripts/manual-active-tab-qa.mjs`, relevant marker/gate tests.

**RED example:** documentation test asserts current architecture and beta scope describe per-site opt-in, screened-excerpt history, subscriptions and retention; it fails against the present “no automatic scanning/no storage” assertions. Run `node --test tests/documentation.test.mjs`; expect those assertions to fail.

**GREEN:** rewrite **current** `docs/architecture.md` and `docs/beta-scope.md` and related current-facing docs to match the new boundary; leave explicitly version-tagged old release evidence historical. Put the future server-guide concept in `IDEAS.md` **only**, not runtime or beta scope. Extend the manual protocol and marker schema/gate for opt-in grant/denial, dynamic panel/SPA removal, stored excerpt/review persistence, subscription CRUD/confirmation, retention, official/fallback link behavior, and accessibility. Never fabricate a human marker: the Linux-only `check:beta` must fail closed without a genuinely completed external marker bound to the **exact final commit, packaged manifest SHA-256, and complete ZIP SHA-256**. First run `npm ci`, `npm run check:release`, full and production `npm audit`, and negative policy tests; then package/verify ONE final archive. Run human QA against that archive's extracted bytes and record the external marker. Finally run `npm run check:beta` in **validation-only, non-rebuilding mode** against that same archive. Add focused gate tests for changed ZIP bytes, absent archive, old marker, changed commit/manifest, and a `check:beta` invocation that would rebuild. Upload only that byte-identical archive and verify the downloaded private release asset hash. Create a new private release only after its real gates pass; do not alter old tags or publish to the Chrome Web Store. **Depends on:** 1–15.

---

## Final release acceptance gates

1. Automated tests prove the DTO's exact keys and length, dual sensitive screening, no raw evidence/selector/URL transport, worker revalidation, and count-only manual Analyze response.
2. A real persisted history readback proves every eligible distinct finding is saved, repeats preserve `firstSeen` and reviewed state, `latestSeen` advances, overflow/quota fails without partial success, and retry after restart is idempotent.
3. A real persisted subscription readback proves manual CRUD and **no automatic confirmation**; validated form fields survive restart.
4. Packaged MV3 tests prove site-isolated consent, challenge/document targeting, revoke and stale-generation denial, zero-finding no-panel behavior, SPA exit removal, badge/popup fallback, and accessibility.
5. Guide catalog tests plus human recheck prove exact official Netflix/Spotify help URLs, dated review metadata, no lookalike match, and origin-only fallback where a trustworthy origin exists.
6. Static package/ZIP checks pass with the worker included. No telemetry, sync, accounts, payment, checkout submission, or cancellation automation is introduced.
7. Current docs and privacy claims match the implementation. New private-beta manual QA and non-rebuilding `check:beta` gates pass with a genuine marker matching the final ZIP hash; if unavailable, report **candidate built, release blocked**, not “released.”

**Residual caveats:** Browser checks around navigation and revocation are not atomic; ordinal identity can change when identical findings reorder; static network scans do not prove every runtime behavior; official guide content can change after review. Document these precisely, test the observable fail-closed cases, and do not claim stronger guarantees.