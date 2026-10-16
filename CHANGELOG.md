# 1.0.0-rc.3 (unreleased)

- Prepare RC3 identity while retaining Chrome numeric version `1.0.0`; preserve published RC1/RC2 history and the immutable 0.4 prototype.
- Document worker-owned native permission completion and truthful unknown-state recovery, plus the 520px popup layout and existing-control refinements.
- Diagnostic Allow/Deny evidence is synthetic automation on Chromium 141 Linux, not human attestation or final RC3 verification. M1 re-review, full final checks, artifact binding, CI, and human acceptance remain pending; human QA is stopped.

# 1.0.0-rc.2 (unreleased)

- Use neutral unsupported-checkout guidance for Analyze without implying a language failure.

# 1.0.0-rc.1 (unreleased)

Production candidate identity; existing local subscription and checkout functionality preserved. Automated validation and unresolved acceptance are recorded in production-readiness.md. No stable promotion, publication, or human approval is claimed.

# Changelog

## 0.4.0-beta.1 (unreleased private opt-in beta candidate)

- Added revocable exact-origin automatic checkout observation and privacy-screened local review history. Manual activeTab Analyze remains independent of opt-in.
- Added explicit observation confirmation through Save subscription, manual subscription CRUD, retention, and bundled source-origin Cancellation Help. Observations never confirm subscriptions automatically; deleting locally does not cancel billing.
- Updated architecture, privacy, and candidate documentation. Task 15/16A/16B and human/release gates remain pending; this is not a new published release.

## 0.3.0-beta.1 (private opt-in beta target)

- Documented the production-ready private opt-in beta target boundary: local user-initiated temporary activeTab access, no persistent host access, local-only page data, and no telemetry, accounts, or uploads. Readiness remains pending a deliberate human activeTab QA marker and a passing `npm run check:beta`.
- Added voluntary manual testing and sanitized external feedback guidance. The extension does not collect feedback.
- Recorded English consumer checkout support, advisory-only notices, false-positive/false-negative risks, and no purchase, payment, account, or cancellation automation.
- Preserved v0.1.0 and v0.2.0 as archived mock-only localhost fixture prototypes, not beta support: <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.1.0> and <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0>.
- Recorded Node 22.12+ contributor prerequisite (currently verified: Node 22.23.2) and that Chrome Web Store policy review/submission are future separate work, not complete.

## 0.2.0 (historical mock prototype)

**v0.2.0 remains an archived mock-only localhost fixture prototype, not beta support.** It was not lost or replaced by the private beta. Its preserved private release is <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0>.

- Hardened the content boundary with exact inbound request schemas, post-injection active-tab rechecking, and panel cleanup when a host removes the extension-owned node.
- Added packaged-extension direct-popup-denial E2E coverage; CDP automation does not create a false activeTab grant.
- Added content-payload/JSDOM dynamic-checkout integrity coverage; it does not claim packaged MV3 or activeTab validation.
- Renamed the local unpacked archive to `ClearChoice-v0.2.0-unpacked.zip`.

## 0.1.0 (historical mock prototype)

**v0.1.0 remains an archived mock-only localhost fixture prototype, not beta support.** Its preserved private release is <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.1.0>.

- Initial local mock-checkout MVP.
