# Changelog

## 0.2.0

- Hardened the private-beta content boundary with exact inbound request schemas, post-injection active-tab rechecking, and panel cleanup when a host removes the extension-owned node.
- Added packaged-extension direct-popup-denial E2E coverage that launches a persistent Chromium context with the generated `dist/` extension, discovers its runtime ID through `chrome://extensions`, and proves CDP automation does not create a false activeTab grant.
- Added a separate content-payload/JSDOM dynamic-checkout integrity test with a fake `chrome` bridge; it verifies page snapshots but does not claim packaged MV3 or activeTab validation.
- Replaced persistent local content-script registration and the retired demo-origin workflow with the private-beta temporary `activeTab` policy.
- Added `npm run check:release` to run release tests, lint, build, E2E, package creation, ZIP integrity, and manifest policy checks.
- Renamed the local unpacked archive to `ClearChoice-v0.2.0-unpacked.zip`.

## 0.1.0

- Initial local mock-checkout MVP.
