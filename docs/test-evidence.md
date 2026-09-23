# ClearChoice v0.2.0 test evidence

This document records commands that must be rerun for the v0.2.0 local release artifact. It is not a production-readiness claim or a security audit.

## Required release commands

```sh
npm run check:release
npm audit --omit=dev
```

`npm run check:release` runs the complete Vitest suite, ESLint, release build, built-extension Playwright cases, package creation, and ZIP inspection. The package verifier requires ordered `activeTab`, `scripting`, `storage` permissions with empty host permissions and rejects duplicates, optional permissions, static content scripts, background workers, external connections, remote executable URLs, secret-like patterns, and emitted runtime assets containing `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource` or `Worker` construction, dynamic `import()`, external resource URLs, or supported DOM URL sinks. It validates both `dist/manifest.json` and the unpacked ZIP root manifest. This static policy does not prove every possible browser/runtime networking behavior is absent.

`npm run check:release` runs the complete historical release suite, but it does not prove a browser-recognized `activeTab` grant. The packaged Playwright case now intentionally shows that CDP keyboard input reaches page JavaScript while a directly opened popup remains denied; it is not a successful action-invocation E2E claim. For the private-beta active-tab acceptance gate, use `npm run manual:active-tab-qa`; after literal `ATTEST`, it emits—but never writes—a data-free JSON self-attestation. Manually save that JSON outside the repository, then deliberately pass its path as `CLEARCHOICE_ACTIVE_TAB_QA_MARKER=PATH npm run check:beta`. The beta gate opens the terminal marker component without following it, validates the regular opened descriptor, and resolves/checks the actual opened target outside the repository before parsing. Parent-directory symlinks are accepted only when that opened target resolves outside the repository; this is not a claim to reject every ancestor symlink. It fails closed without a current pass-only marker bound to the Git commit and manifest hash. The marker's reviewer value is the fixed `local-human-attestation` literal; it is a local self-attestation, not cryptographic proof that CI can use to prove a human gesture.

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
