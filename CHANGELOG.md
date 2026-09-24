# Changelog

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
