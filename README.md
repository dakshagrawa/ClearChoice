# ClearChoice v0.2.0

ClearChoice is an **unpublished, non-production Chromium Manifest V3 private beta**. It is not published, store-distributed, or production-ready.

## Private-beta scope

- The generated and packaged manifest declares exactly `activeTab`, `scripting`, and `storage`, in that order.
- It declares `host_permissions: []`, no optional permissions or optional host permissions, no `content_scripts`, no background worker, and no external connections.
- `activeTab` grants temporary access only after the user invokes the extension on the active tab. Task 1 establishes this manifest contract only; current-tab injection is not implemented yet.
- The extension has no persistent host access. Local checkout fixtures remain available for internal testing, but their host is not exposed by the manifest.
- The analysis is user initiated and reads visible page text and checked checkbox/radio labels when the beta injection flow is implemented.

## Explicit non-goals and limits

This beta does **not** access accounts, payment data, or cancellation flows; perform checkout actions; modify checkout controls, selections, prices, forms, or page content; make legal/compliance determinations; support browser stores or real production use; or include remote code, network APIs, or secrets.

The package verifier fail-closes emitted assets containing network APIs, remote executable URLs, secret-like patterns, dynamic imports, and external resource URL sinks. It is a static check, not proof that every browser/runtime network behavior is impossible.

## Manual fixtures

Run `npm ci`, `npm run build`, and `npm run serve:fixtures`. Controlled fake-checkout scenarios remain available at the server URL printed by the fixture server. They are internal test fixtures only; loading the built extension does not register a script for their host.

## Build and verification

```sh
npm test
npm run lint
npm run build
npm run package:unpacked
npm run verify:archive
```

`dist/` and `ClearChoice-v0.2.0-unpacked.zip` are local build artifacts, not published packages. See [PRIVACY.md](PRIVACY.md) and [docs/threat-model.md](docs/threat-model.md).
