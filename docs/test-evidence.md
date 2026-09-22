# ClearChoice MVP test evidence

This document records verification performed on the documented MVP working tree. It is evidence for the current local artifact, not a claim of production readiness or a security audit.

## Baseline observation

At the frozen baseline, `npm run lint`, `npm run build`, and `npm run e2e` pass. The full `npm test -- --run` suite currently fails because `tests/serve-fixtures.test.mjs` encounters `EADDRINUSE` on `127.0.0.1:4173` while the manual fixture server is running. This is an environment/parallelism defect slated for Task 2, not a passing claim.

## Commands and observed outcomes

All commands were run from the repository root with `PATH="$HOME/.local/bin:$PATH"`.

```sh
npm test
npm run lint
npm run build
npm run e2e
npm run package:unpacked
unzip -l ClearChoice-mvp-unpacked.zip
unzip -Z1 ClearChoice-mvp-unpacked.zip | python3 -c "import sys; names=sys.stdin.read().splitlines(); assert 'manifest.json' in names, names; assert all(not name.startswith('dist/') for name in names), names; print('ZIP inspection passed: manifest.json is at archive root; %d entries' % len(names))"
```

Observed results:

- Before the manual fixture server was started, `npm test` passed — 6 test files and 38 tests passed. This historical result includes 13 detector tests, popup/panel/storage/message tests, and 15 package-contract tests.
- `npm run lint`: passed — `eslint .` exited `0` with no diagnostics.
- `npm run build`: passed — TypeScript completed, Vite emitted `dist/`, and `npm run verify:package` reported `artifact policy check passed (static package policy only; does not prove all runtime behavior)`.
- `npm run e2e`: passed — 1 Playwright test passed. It starts a self-created `127.0.0.1` fixture, loads `dist/` as an unpacked Chromium extension, clicks **Analyze**, verifies two displayed findings, dismisses the panel, reloads the fixture, confirms dismissal persistence, and asserts no observed popup/fixture console or page errors.
- `npm run package:unpacked`: passed — rebuilt and rechecked `dist/`, then created `ClearChoice-mvp-unpacked.zip` locally.
- ZIP inspection: passed — archive contained 6 entries and `manifest.json` at its root (not under `dist/`).

## Package-policy verifier scope

`npm run verify:package` validates the emitted `dist/` manifest and scans emitted `.js`, `.mjs`, `.cjs`, `.css`, `.html`, and `.json` assets. It requires MV3; exactly `activeTab`, `scripting`, and `storage`; no host permissions; and exactly one content script matching `http://127.0.0.1/*` with `content.js`. It rejects optional permissions/hosts, external connections, background service workers, remote executable URLs, static network API patterns (`fetch`, `XMLHttpRequest`, `WebSocket`), and secret-like key/token/password patterns.

The verifier is a static package-policy control. It does not prove all runtime behavior, every browser capability, future changes, or absence of every possible data flow.

## Browser and scope limitations

The E2E test is limited to Chromium and a test-created local mock checkout. It does not test Firefox, browser-store installation, publication, real checkout sites, account workflows, payment flows, cancellation flows, legal claims, or production security operations.

ClearChoice remains an unpublished, non-production MVP. The generated ZIP is a local unpacked-loading convenience artifact only; it was not uploaded or published.
