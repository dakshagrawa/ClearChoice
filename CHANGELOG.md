# Changelog

## 0.2.0

- Hardened the private-beta content boundary with exact inbound request schemas, post-injection active-tab rechecking, and panel cleanup when a host removes the extension-owned node.
- Added packaged-extension E2E coverage that launches a persistent Chromium context with the generated `dist/` extension, discovers its runtime ID through `chrome://extensions`, opens its popup document, and targets loopback fixtures.
- Updated the beta privacy, architecture, and threat-model boundary to describe implemented Task 2 injection and its unavoidable asynchronous focus race.
- Replaced the placeholder E2E test with five packaged-extension Chromium scenarios against ephemeral loopback fixtures: clean, recurring, paid add-on, mixed, and dismiss/reload/Restore preservation.
- Replaced persistent local content-script registration and the retired demo-origin workflow with the private-beta temporary `activeTab` policy.
- Added `npm run check:release` to run release tests, lint, build, E2E, package creation, ZIP integrity, and manifest policy checks.
- Renamed the local unpacked archive to `ClearChoice-v0.2.0-unpacked.zip`.

## 0.1.0

- Initial local mock-checkout MVP.
