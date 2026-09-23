# Changelog

## 0.2.0

- Replaced the placeholder E2E test with five built-extension Chromium scenarios against ephemeral loopback fixtures: clean, recurring, paid add-on, mixed, and dismiss/reload/Restore preservation.
- Replaced persistent local content-script registration and the retired demo-origin workflow with the private-beta temporary `activeTab` policy.
- Added `npm run check:release` to run release tests, lint, build, E2E, package creation, ZIP integrity, and manifest policy checks.
- Renamed the local unpacked archive to `ClearChoice-v0.2.0-unpacked.zip`.

## 0.1.0

- Initial local mock-checkout MVP.
