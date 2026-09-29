# ClearChoice 0.3.0-beta.1 private-beta threat model

ClearChoice's production-ready target is a **private opt-in beta** as `0.3.0-beta.1`. Readiness remains pending required checklist and gate completion; the final human activeTab QA marker remains required, and `npm run check:beta` must pass before readiness can be claimed. It is not a Chrome Web Store release or public distribution.

## System boundary

Manual Analyze remains user-invoked under temporary `activeTab` access; it does not grant optional host permissions or register an automatic scanner. The popup sends only a command to the MV3 worker. The worker gates storage access with `TRUSTED_CONTEXTS`, initializes retention, checks the active tab around injection, and sends to the top-frame `InjectionResult.documentId` only. A per-document challenge authenticates content submissions by sender tab, top frame, document ID, origin, and active-tab checkpoint; only validated screened findings enter local review history. Content requests dismissal state through the worker instead of calling local storage. Popup replies contain only count/status/error, never findings. These asynchronous focus checks cannot be atomic with `tabs.sendMessage`: a switch in the check-to-send interval remains a residual race; a switch detected at a checkpoint fails closed. Automatic opt-in scanning is not implemented at this stage.

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
