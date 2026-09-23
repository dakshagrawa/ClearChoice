# ClearChoice 0.3.0-beta.1 private-beta privacy notice

ClearChoice is a production-ready **private opt-in beta** targeted as `0.3.0-beta.1`, not a public service or Chrome Web Store release.

## Access and data handling

The user clicks **Analyze this tab** locally. That action grants temporary `activeTab` access to the active tab. ClearChoice has no persistent host access, no static content scripts, and no automatic page scanning.

All page data stays local. There is no telemetry, accounts, or uploads; ClearChoice has no backend and does not transmit page data. Analysis briefly evaluates visible evidence in the injected page context. It excludes typed `input`, `textarea`, `select`, and `contenteditable` values. Static page text can be transiently inspected to evaluate a candidate, but a sensitive-looking static context or finding candidate containing an email, payment card/PAN or masked-card pattern, account/bank/routing number, CVV, or security-code text is discarded whole rather than redacted or retained. The popup receives only a typed status and integer finding count.

A dismissed findings-panel state may be stored in `chrome.storage.local`. It is not used for tracking, analytics, synchronization, advertising, or profiling. The separate human manual-QA marker is voluntary local self-attestation outside the repository; it is not feedback collection by the extension and is not cryptographic proof of a gesture.

## What ClearChoice does not do

- It does not have persistent access to any host.
- It does not read typed form or `contenteditable` values.
- It does not automate or initiate purchases, payments, accounts, cancellations, refunds, subscriptions, or form submission.
- It does not modify checkout choices, controls, prices, or forms.
- It provides advisory-only notices and does not make a legal, compliance, safety, or deceptive-site conclusion.

See [the threat model](docs/threat-model.md), [beta test protocol](docs/beta-test-protocol.md), and [beta release checklist](docs/beta-release-checklist.md) for boundaries and testing requirements. Chrome Web Store policy review and submission are future separate work, not complete.
