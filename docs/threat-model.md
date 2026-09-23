# ClearChoice 0.3.0-beta.1 private-beta threat model

ClearChoice is a production-ready **private opt-in beta** targeted as `0.3.0-beta.1`. It is not a Chrome Web Store release or public distribution.

## System boundary

A user clicks **Analyze this tab** locally. The browser then grants temporary `activeTab` access to the active tab for that user invocation. The manifest has no persistent host access, static content scripts, optional host permissions, background worker, or external connection declaration. Analyze and Restore recheck the selected active tab around programmatic injection; an observed switch cancels the request. A tab switch after an asynchronous checkpoint is a residual race that extension code cannot make atomic.

All page data stays local. There is no telemetry, accounts, or uploads, no network API, and no backend. Analysis runs locally in the injected page context. Typed `input`, `textarea`, `select`, and `contenteditable` values are excluded. Static visible text can be transiently inspected while evaluating candidates, but a static context or finding candidate containing an email, payment card/PAN or masked card, account/bank/routing number, CVV, or security code is discarded whole before evidence, messages, or storage.

## Assets, threats, and limits

| Concern | Mitigation | Residual limit |
| --- | --- | --- |
| Broad page access | Temporary `activeTab` access follows a deliberate local user action; no persistent host access is declared. | Browser enforcement and user action remain trusted. |
| Page data exposure | All page data local; no telemetry, accounts, or uploads. Sensitive-looking static candidates are discarded whole. | Static page text may be transiently read to evaluate a candidate before it is discarded. |
| Wrong or incomplete notice | English consumer checkout heuristics are advisory only. | False positives and false negatives are expected; a notice does not conclude a site is deceptive, legal, illegal, compliant, safe, or unsafe. |
| Checkout automation | The extension does not automate purchases, payments, accounts, cancellations, refunds, subscriptions, or submission, and does not modify checkout controls or forms. | A hostile page controls its own DOM and behavior. |
| Human QA assertion | `check:beta` accepts only a deliberately saved external local marker for the exact commit and manifest. | The marker is self-attestation, not cryptographic proof of a user gesture. Missing markers must fail closed. |

## Out of scope

This beta does not support non-English or non-consumer-checkout contexts, restricted or unsupported pages, browser-store distribution, legal/compliance review, or a consumer-protection guarantee. Chrome Web Store policy review and submission are future separate work, not complete.

See [the beta test protocol](beta-test-protocol.md) and [rule catalog](rule-catalog.md) for tester responsibilities and heuristic limits.
