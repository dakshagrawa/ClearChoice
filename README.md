# ClearChoice 0.3.0-beta.1

ClearChoice is an **unpublished, non-production Linux Chromium Manifest V3 private beta**. It is not published, store-distributed, or production-ready.

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

Automated Playwright/CDP input reaches page JavaScript but does not invoke Chromium's extension action, so it cannot prove an `activeTab` grant. The packaged E2E intentionally proves that this path remains denied; it is **not** an automated active-tab success claim. This private beta and its `check:beta` manual-marker gate are supported only on Linux Chromium: marker validation deliberately binds the open file descriptor through Linux `/proc/self/fd`, so `check:beta` fails closed with an explicit diagnostic on macOS and Windows rather than claiming portability.

After `npm run build`, run the following locally with a human available to use the visible browser chrome:

```sh
npm run manual:active-tab-qa
# Copy the emitted JSON into ~/.local/state/clearchoice/active-tab-qa.json (outside this repository).
CLEARCHOICE_ACTIVE_TAB_QA_MARKER="$HOME/.local/state/clearchoice/active-tab-qa.json" npm run check:beta
```

The manual program creates its own ephemeral `127.0.0.1` fixture server, derives the only navigated URLs from that bound server, creates a clean temporary Chromium profile, and loads the built unpacked `dist/` extension. Its runner-provided Chromium uses a dead explicit proxy, explicitly bypasses only `127.0.0.1`, disables Chromium's implicit loopback bypass with `<-loopback>`, and disables QUIC. The automated Chromium boundary test proves that exact fixture reaches its server while `127.0.0.2` and a non-loopback probe fail; it cannot validate real sites. This launch boundary applies only to Chromium started by this manual runner, not any other browser instance. The human first performs a pointer toolbar-click and pointer popup-Analyze on the clean fixture, then repeats those pointer actions on the dynamic fake checkout. The dynamic protocol also requires pointer Dismiss, toolbar/popup pointer Restore, two toolbar/popup pointer Analyze actions, and pointer replacement of the fake order summary. For each comparison, the runner transiently computes an in-page canonical integrity representation and reads that controlled fake-fixture value only to derive a SHA-256 digest. Retained QA state contains only that digest and boolean pass/fail predicates; it retains no URL, form/control value, node reference, name/type, selector, evidence, HTML, title, or finding, and it neither writes nor prints page data. After all steps, the reviewer must type `ATTEST` in the terminal. The runner then emits—but never writes—a pass-only JSON marker; manually save it outside the repository. Use only the fixtures: do not sign in, enter data, visit a real site, make a payment, or make a purchase.

`check:beta` requires a deliberately saved marker that resolves outside this repository at read time. It opens the marker with no-follow protection for the terminal path component, validates the opened descriptor is a regular file, then resolves and checks that actual opened target before parsing; it rejects terminal symlinks, unreadable/nonregular files, and targets inside the repository. Parent-directory symlinks may be used only when the opened target resolves outside the repository. This validates the opened file rather than promising to reject every ancestor symlink. The marker contains exactly `schemaVersion: 2`, `outcome: "passed"`, `cleanFixtureIntegrity: "passed"`, `dynamicFixtureIntegrity: "passed"`, current Git commit, manifest SHA-256, and fixed `reviewer: "local-human-attestation"`—never a URL, title, DOM text/HTML, selector, evidence, form value, or finding. It is an intentionally local self-attestation, not cryptographic proof: automation can verify exact build identity and the marker shape, but CI cannot prove the human toolbar click, pointer Analyze gesture, terminal acknowledgement, or actual fixture actions. `check:beta` fails closed if the external marker is absent, unreadable, stale, malformed, non-pass, lacks either required fixture attestation, or lacks the exact fixed attestation token.


```sh
npm test
npm run lint
npm run build
npm run package:unpacked
npm run verify:archive
npm run e2e
```

`dist/` and `ClearChoice-v0.2.0-unpacked.zip` are local build artifacts, not published packages. See [PRIVACY.md](PRIVACY.md) and [docs/threat-model.md](docs/threat-model.md).
