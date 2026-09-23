# ClearChoice v0.2.0 test evidence

This document records commands that must be rerun for the v0.2.0 local release artifact. It is not a production-readiness claim or a security audit.

## Required release commands

```sh
npm run check:release
npm audit --omit=dev
```

`npm run check:release` runs the complete Vitest suite, ESLint, release build, the packaged direct-popup-denial Playwright case, package creation, and ZIP inspection. The package verifier requires ordered `activeTab`, `scripting`, `storage` permissions with empty host permissions and rejects duplicates, optional permissions, static content scripts, background workers, external connections, remote executable URLs, secret-like patterns, and emitted runtime assets containing `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource` or `Worker` construction, dynamic `import()`, external resource URLs, or supported DOM URL sinks. It validates both `dist/manifest.json` and the unpacked ZIP root manifest. This static policy does not prove every possible browser/runtime networking behavior is absent.

Automated payload integrity evidence is the clearly named `content-payload/JSDOM integration` test under `src/content/index.test.ts`. It uses a fake `chrome` bridge to exercise the content payload and asserts only that the dynamic fake checkout's URL, form actions, controls, and host control identities remain unchanged through Analyze, Dismiss, Restore, repeated Analyze, and summary replacement. It does **not** validate a packaged MV3 extension, popup, `activeTab`, browser injection, or a production site.

The packaged Playwright case intentionally shows that CDP keyboard input reaches page JavaScript while a directly opened popup remains denied. It proves no false `activeTab` grant; it is not a successful action-invocation E2E claim. Successful `activeTab` and real-browser integrity evidence require the Linux Chromium human protocol: `npm run manual:active-tab-qa` launches clean and dynamic fake fixtures, and a person uses pointer toolbar/popup actions. For integrity comparison, the runner transiently computes an in-page canonical representation and transiently reads controlled fake-fixture data only to derive a SHA-256 digest. Its retained QA state contains only that digest and boolean predicates, while marker/output objects contain only predicate and attestation fields; no retained state or output contains page data. It emits its marker only after literal `ATTEST`. The marker is schema version 2 and must attest `cleanFixtureIntegrity: "passed"` and `dynamicFixtureIntegrity: "passed"`, alongside its commit/manifest binding and fixed local-human-attestation token. Save it outside the repository, then deliberately pass its path as `CLEARCHOICE_ACTIVE_TAB_QA_MARKER=PATH npm run check:beta`.

The private-beta active-tab acceptance gate is supported only on Linux Chromium because `check:beta` binds its opened marker descriptor through Linux `/proc/self/fd`; it fails closed with an explicit diagnostic on macOS and Windows rather than claiming support. The beta gate opens the terminal marker component without following it, validates the regular opened descriptor, and resolves/checks that same opened descriptor target outside the repository before parsing. Its regression test swaps a parent symlink after the safe open and proves validation still reads the original external marker, not a reopened pathname. Parent-directory symlinks are accepted only when that opened target resolves outside the repository; this is not a claim to reject every ancestor symlink. The fixed reviewer value is a local self-attestation, not cryptographic proof that CI can use to prove a human gesture.

## Scope limitations

The checks are limited to Chromium and controlled local mock fixtures. They do not test Firefox, browser-store publication, real checkout sites, accounts, payment flows, cancellation flows, legal conclusions, or production security operations. The generated ZIP is local-only and is not uploaded or published.
