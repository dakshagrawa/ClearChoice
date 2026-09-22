# ClearChoice v0.2.0 test evidence

This document records commands that must be rerun for the v0.2.0 local release artifact. It is not a production-readiness claim or a security audit.

## Required release commands

```sh
npm run check:release
npm audit --omit=dev
```

`npm run check:release` runs the complete Vitest suite, ESLint, release build, five built-extension Playwright cases, package creation, and ZIP inspection. Its ZIP inspection parses the root `manifest.json` and fails if the ZIP contains a Tailnet hostname; optional permissions; non-empty host permissions; an external connection declaration; a service worker; or content-script matches other than `http://127.0.0.1/*`.

The Playwright suite starts an ephemeral `127.0.0.1` fixture server on port `0`, uses a built unpacked extension, makes actual popup pointer clicks, and captures page/console errors. The scenarios assert: clean checkout has zero finding types; recurring has one recurring type; paid add-on has one add-on type; mixed has two types; and dismiss/reload/Restore retains the fixture URL and checked checkbox.

## Observed v0.2.0 results

From the final local release-gate run:

- `npm run check:release` exited `0`.
- Vitest: 8 files and 57 tests passed.
- ESLint exited `0` with no diagnostics.
- Playwright: 5 tests passed.
- The package verifier passed and the ZIP integrity check reported 6 entries with parsed manifest version `0.2.0`.
- `npm audit --omit=dev` exited `0` and reported `found 0 vulnerabilities`.

## Scope limitations

The checks are limited to Chromium and controlled local mock fixtures. They do not test Firefox, browser-store publication, real checkout sites, accounts, payment flows, cancellation flows, legal conclusions, or production security operations. The generated ZIP is local-only and is not uploaded or published.
