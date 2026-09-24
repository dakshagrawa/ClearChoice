# ClearChoice 0.3.0-beta.1 private opt-in beta

ClearChoice's production-ready target is a **private opt-in beta** as `0.3.0-beta.1`. Readiness remains pending required checklist and gate completion, including a final human activeTab QA marker and a passing `npm run check:beta`. It is distributed only for invited testing from this private repository; it is not a Chrome Web Store release or a public store listing.

## What the beta does

A user clicks **Analyze this tab** locally. That deliberate action gives ClearChoice temporary `activeTab` access to the current tab only. The extension has no persistent host access, does not automatically scan pages, and does not inject a static content script.

ClearChoice supports English consumer checkout-like pages. It gives advisory-only notices from visible evidence; it does not conclude that a site is deceptive, legal, illegal, compliant, safe, or unsafe. Heuristic results can have false positives and false negatives; read the notice against the visible page text before relying on it.

All page data stays local. There is no telemetry, accounts, or uploads, and no page data is sent to a service. The analysis excludes typed `input`, `textarea`, `select`, and `contenteditable` values. It can transiently inspect static visible text to evaluate candidates, but discards an entire static context or finding candidate that looks like it displays an email, payment card/PAN or masked card, account/bank/routing number, CVV, or security code; it does not redact or retain that candidate. The popup receives only typed status and an integer finding count.

ClearChoice does not automate purchases, payments, account actions, cancellations, refunds, subscriptions, or form submission. It does not alter checkout controls, selections, prices, forms, or page content.

## Testing the beta

Read [the beta test protocol](docs/beta-test-protocol.md) before using the beta, and use [the feedback template](docs/beta-feedback-template.md) for optional external feedback. The extension does not collect feedback.

Contributors need Node **22.12+**; the current verified version is **Node 22.23.2**. From a clean checkout:

```sh
npm ci
npm test -- --run
npm run lint
npm run build
npm run e2e
npm run package:unpacked
npm run verify:archive
npm audit --omit=dev
```

`npm run check:beta` additionally requires a real external human activeTab QA marker. Do not create or forge one for automation. Without that marker, it must fail closed:

```sh
npm run check:beta
# check:beta failed: CLEARCHOICE_ACTIVE_TAB_QA_MARKER must point to a deliberate local manual-QA marker
```

The manual marker protocol is Linux Chromium-only because it verifies an opened marker descriptor through `/proc/self/fd`; macOS and Windows fail closed. See [the beta release checklist](docs/beta-release-checklist.md) for the exact gate and [the threat model](docs/threat-model.md) for residual risks.

## Historical prototypes

**v0.1.0 and v0.2.0 are archived mock-only localhost fixture prototypes, not beta support.** Their preserved private releases are <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.1.0> and <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0>. Use only their controlled localhost fixtures and the v0.2.0 historical [release checklist](docs/release-checklist.md); do not interpret either archive as real-site support, production readiness, or beta eligibility.

## External compliance references

Retrieved **2026-09-23**:

- <https://developer.chrome.com/docs/extensions/develop/concepts/activeTab>
- <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- <https://developer.chrome.com/docs/webstore/program-policies>

Chrome Web Store policy review and submission are future separate work, not complete.
