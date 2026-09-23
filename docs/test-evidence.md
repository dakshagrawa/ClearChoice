# ClearChoice v0.2.0 test evidence

This document records commands that must be rerun for the v0.2.0 local release artifact. It is not a production-readiness claim or a security audit.

## Required release commands

```sh
npm run check:release
npm audit --omit=dev
```

`npm run check:release` runs the complete Vitest suite, ESLint, release build, built-extension Playwright cases, package creation, and ZIP inspection. The package verifier requires ordered `activeTab`, `scripting`, `storage` permissions with empty host permissions and rejects duplicates, optional permissions, static content scripts, background workers, external connections, remote executable URLs, secret-like patterns, and emitted runtime assets containing `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource` or `Worker` construction, dynamic `import()`, external resource URLs, or supported DOM URL sinks. It validates both `dist/manifest.json` and the unpacked ZIP root manifest. This static policy does not prove every possible browser/runtime networking behavior is absent.

The existing Playwright suite starts an ephemeral `127.0.0.1` fixture server on port `0` and still exercises the prior static-content-script behavior. It is intentionally expected to fail until Task 2 implements user-invoked current-tab injection and refactors those E2E cases; Task 1 preserves the suite rather than weakening or deleting it.

## Observed v0.2.0 results

From the final local release-gate run:

- `npm run check:release` exited `0`.
- Vitest: 8 files and 76 tests passed.
- ESLint exited `0` with no diagnostics.
- Playwright: 5 tests passed.
- The package verifier passed and the ZIP integrity check reported 6 entries with parsed manifest version `0.2.0`.
- `npm audit --omit=dev` exited `0` and reported `found 0 vulnerabilities`.

## Scope limitations

The checks are limited to Chromium and controlled local mock fixtures. They do not test Firefox, browser-store publication, real checkout sites, accounts, payment flows, cancellation flows, legal conclusions, or production security operations. The generated ZIP is local-only and is not uploaded or published.
