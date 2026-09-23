# ClearChoice 0.3.0-beta.1

ClearChoice is an **unpublished, non-production Chromium Manifest V3 private beta**. It is not published, store-distributed, or production-ready.

## Private-beta scope

- The generated and packaged manifest declares exactly `activeTab`, `scripting`, and `storage`, in that order.
- It declares `host_permissions: []`, no optional permissions or optional host permissions, no `content_scripts`, no background worker, and no external connections.
- The manifest also declares exactly one browser action shortcut: `_execute_action` with `Ctrl+Shift+Y`. It is a real user affordance for opening the action popup; it does not make Playwright/CDP key injection a browser-recognized action invocation.
- `activeTab` grants temporary access only after the user invokes the extension action on the active tab. Analyze and Restore begin from the current active tab in the current window, inject `dist/content.js` programmatically, and recheck that same tab before and after awaited injection before messaging it.
- A switch observed at either recheck cancels the request. Extension code cannot atomically hold browser focus across an asynchronous injection or message operation, so it cannot eliminate a race occurring after a recheck checkpoint.
- The extension has no persistent host access. Local checkout fixtures remain available for internal testing, but their host is not exposed by the manifest.
- `dist/content.js` is the intentional local payload for programmatic injection, not a dead build artifact or a static content script.
- The analysis is user initiated and reads visible page text and checked checkbox/radio labels only in the injected page context. The popup receives only a typed status and integer finding count.

See [the beta scope](docs/beta-scope.md) and [beta release checklist](docs/beta-release-checklist.md) for current private-beta boundaries and gates.

## Explicit non-goals and limits

This beta does **not** access accounts, payment data, or cancellation flows; perform checkout actions; modify checkout controls, selections, prices, forms, or page content; make legal/compliance determinations; support browser stores or real production use; or include remote code, network APIs, or secrets.

The package verifier fail-closes emitted assets containing network APIs, remote executable URLs, secret-like patterns, dynamic imports, and external resource URL sinks. It is a static check, not proof that every browser/runtime network behavior is impossible.

## Manual fixtures

Run `npm ci`, `npm run build`, and `npm run serve:fixtures`. Controlled fake-checkout scenarios remain available at the server URL printed by the fixture server. They are internal test fixtures only; loading the built extension does not register a script for their host.

## Manual active-tab QA (required for beta gate)

Automated Playwright/CDP input reaches page JavaScript but does not invoke Chromium's extension action, so it cannot prove an `activeTab` grant. The packaged E2E intentionally proves that this path remains denied; it is **not** an automated active-tab success claim.

After `npm run build`, run the following locally with a human available to use the visible browser chrome:

```sh
npm run manual:active-tab-qa -- --marker "$HOME/.clearchoice/active-tab-qa.json" --reviewer "YOUR_LOCAL_QA_SIGNOFF"
CLEARCHOICE_ACTIVE_TAB_QA_MARKER="$HOME/.clearchoice/active-tab-qa.json" npm run check:beta
```

The manual program creates a clean temporary Chromium profile, loads the built unpacked `dist/` extension and a `127.0.0.1` local fake checkout, and waits for a human to click the real toolbar icon and then **Analyze** with the pointer. Its runner-provided Chromium uses a dead explicit proxy for every non-loopback request, bypassing it only for `127.0.0.1`, and disables QUIC; it can access only the local fixture and extension and cannot validate real sites. This launch boundary applies only to Chromium started by this manual runner, not any other browser instance. After the local fixture receives the panel, the reviewer must type `ATTEST` in the terminal before the program writes its pass-only marker. Use only the fixture: do not sign in, enter data, visit a real site, make a payment, or make a purchase.

The marker path must be explicitly supplied **outside this repository** (the example uses `$HOME/.clearchoice/`); the program and `check:beta` reject an in-repository path so the marker cannot be committed or placed in the ZIP archive. It contains exactly `schemaVersion: 1`, `outcome: "passed"`, current Git commit, manifest SHA-256, and reviewer sign-off—never a URL, title, DOM text/HTML, selector, evidence, form value, or finding. This is a human attestation: automation can confirm only that its direct-popup path is denied, not that Chromium recognized a toolbar click. `check:beta` fails closed if the external marker is absent, unreadable, stale, malformed, non-pass, or lacks a reviewer sign-off.


```sh
npm test
npm run lint
npm run build
npm run package:unpacked
npm run verify:archive
npm run e2e
```

`dist/` and `ClearChoice-v0.2.0-unpacked.zip` are local build artifacts, not published packages. See [PRIVACY.md](PRIVACY.md) and [docs/threat-model.md](docs/threat-model.md).
