# ClearChoice private-beta mock-only human QA protocol

This protocol targets `0.4.0-beta.1`. **Task16B is partially implemented: no human QA has been performed and the runner cannot emit a passing marker yet.** Automated test callbacks are not human evidence. Site consent, denial, isolation and revoke checkpoints are available; expanded history CRUD, subscription, retention, restart durability and cancellation-help stages remain pending.

## Safety boundary

- Use only the disposable Chromium profile and mock pages supplied by `npm run manual:active-tab-qa`. Never use your personal profile, real checkout, purchase, payment, cancellation or account page.
- The runner extracts the existing exact candidate ZIP using `prepareCandidateArchive`; it must not build or replace the archive after QA. Dirty tracked source fails closed.
- Fixtures contain no forms, account inputs or payment controls. HTTPS `checkout-a.test` and `checkout-b.test` resolve only to the runner's ephemeral `127.0.0.1` listener. A dead proxy bypasses only those two names, all other DNS names are unmapped and QUIC is disabled. A one-day scratch certificate is trusted only through its SPKI pin in this Chromium process. This does not constrain other browsers.
- Read-only observations retain only SHA-256 host-integrity digests and pass/fail predicates. Do not collect raw DOM, values, selectors, URLs or screenshots in markers or feedback. Fixture navigation addresses shown to the operator are not marker data.
- Every browser gesture belongs to the human. The runner must not click controls, send keys or seed permissions to imitate consent.

## Implemented baseline

1. Human toolbar Analyze on clean zero: acknowledge the completed action, read back quiet panel/storage state and check host integrity. Do **not** wait for an empty findings panel to attach.
2. Human Analyze on the positive dynamic mock, Escape, Restore, reanalyze, Dismiss, Restore, repeated Analyze and mock summary replacement; panel transitions and integrity checks gate progress.
3. On clean A, human toolbar → Enable detection for this site → **ALLOW** the genuine native permission prompt. Read back exact browser permission, enabled generation, matching isolated persistent `content.js` registration and unchanged history/subscriptions; clean page/panel/badge remain quiet.
4. Runner navigates A to the form-free recurring fixture. Without Analyze or Save, require a changed accepted history snapshot, recurring item, badge `1` and one automatic panel, then human `DONE`. This does not create a confirmed subscription.
5. First visit to distinct **checkout-b.test** remains unopted and quiet through a bounded observation interval. Human toolbar → Enable → **DENY** the native prompt. Observe the exact production popup denial status before separate `DONE`, then verify no B permission, grant, registration, history or panel. Missing permission alone is not proof of denial.
6. Return to A, observe automatic detection, capture history/subscription digests, then human toolbar → Disable. Require permission/script removal, disabled next generation, blank badge, removed panel and preserved records. Human mock-summary replacement and another mock navigation must remain quiet with no new history.
7. The runner then stops explicitly as pending. It does not offer final ATTEST or produce a marker. Human stages require observation followed by `DONE`; observations and acknowledgement have bounded waits. If no genuine Chrome permission prompt is available, abort rather than simulate consent or denial.

## Required remaining staged acceptance checks

Implement one window/tab/action per prompt with read-only storage, permissions and registered-content-script readback:

- **Automatic lifecycle:** two identical distinct records stay distinct, repeat/reload deduplicate, SPA exit removes stale UI. The available A/B site slice does not cover this full matrix.
- **Review/history and subscriptions:** ambiguous Review As stays blank; Cancel creates nothing. Explicit Save with fake fields records matching provenance. Verify manual create/update/cancel/delete, local-only deletion and restart durability through readback.
- **Retention:** clearly label isolated fake-old-observation seeds; shorter retention expires those observations while confirmed subscriptions survive. Seeds must never simulate consent or a real purchase.
- **Cancellation help:** unknown mock origins show only Visit site; manual merchant text Netflix does not establish provenance. A separate clearly labeled seeded observation scenario may inspect Netflix/Spotify canonical guide hrefs, literal dates and caveats without navigating to providers or accounts. Expected catalog date is `2026-09-29`; current article human recheck remains required. Seeded tests do not prove a production billing relationship.
- **Additional revocation/restart:** reenable requires another human permission prompt. Chrome Settings/extension site-access removal requires explicit human action. The current load flags are not genuine browser-restart proof; a future install-once CDP stage must verify restart durability without reinstalling.
- **Accessibility and integrity:** human focus visibility, Escape, pointer Restore and dismiss behavior; host digests remain unchanged at relevant stages.

Only after every actual predicate has passed may a human explicitly type **ATTEST**. Finalization must recheck clean commit and the original candidate ZIP bytes without rebuilding. Cleanup must attempt terminal, browser, server, profile and candidate removal independently without hiding the primary error.

## Expanded exact-artifact attestation

Schema **4** requires exactly the fixed commit, packaged-manifest hash, archive hash, `local-human-attestation` reviewer, passed outcome, clean/dynamic integrity, accessibility, and passed `optInConsent`, `optInDenial`, `siteIsolation`, `automaticLifecycle`, `revocation`, `reviewHistory`, `subscriptions`, `retention`, `cancellationHelp`. Missing, false, non-pass, extra or old-schema fields fail closed. The constructor requires explicit complete workflow results; it cannot generate PASS from candidate identity alone.

The eventual marker is JSON on stdout only, never written to a caller path by the runner. Save only a genuine completed human attestation outside the repository, then supply `CLEARCHOICE_ACTIVE_TAB_QA_MARKER` to `npm run check:beta`. Until the remaining stages are implemented and a human completes them, the gate remains closed. Do not forge a marker or treat unit fixtures as a real attestation.
