# ClearChoice 0.3.0-beta.1 private-beta threat model

## System boundary

ClearChoice is an unpublished Chromium Manifest V3 private beta with a popup. Its generated manifest declares exactly `activeTab`, `scripting`, and `storage`, `host_permissions: []`, and exactly one `_execute_action` command with the suggested `Ctrl+Shift+Y` shortcut. It declares no static content script, optional permission, background worker, or external connection. `activeTab` grants temporary access to the active tab after user invocation.

Task 2 implements current-tab injection as current beta work; it is not release-ready. Analyze and Restore select the active current tab, recheck it before injection and after awaited injection, then message it only if it remains active at the observed checkpoints. Extension code cannot atomically guarantee focus between those asynchronous operations, so a tab switch just after a checkpoint remains a residual race.

Controlled local fixtures remain available for internal testing, but their host is not in the manifest and receives no persistent extension access. See [beta scope](beta-scope.md) and the [beta release checklist](beta-release-checklist.md) for current boundary and acceptance gates.

## Assets and intended protections

| Asset / concern | Private-beta boundary |
| --- | --- |
| Page text and findings | User invocation triggers temporary active-tab processing. Content requests and popup responses use closed schemas; page data remains in the page context. |
| Temporary active-tab authorization | A human toolbar-action click is required before popup Analyze/Restore can inject into the current active tab. The `_execute_action` shortcut is a documented user affordance. Automated Playwright/CDP input is intentionally treated as denied and cannot attest to this grant. The beta gate requires a local human-QA pass marker bound to the commit and manifest; no automated success claim is made. |
| Accounts, credentials, payment data | Not accessed; no account permissions, login flows, or checkout actions exist. |
| Local persistence | `chrome.storage.local` is limited to the dismissible findings-panel state. |

## Threats and mitigations

| Threat | Private-beta mitigation | Residual risk / limit |
| --- | --- | --- |
| Broad or persistent host access | Manifest validation requires the ordered `activeTab`, `scripting`, `storage` set and empty host permissions; it rejects optional grants and all content scripts. | Temporary user-invoked access still depends on browser enforcement. |
| Tab switch during analysis | The target is rechecked before injection and after awaited injection; observed switches cancel before messaging. | Extension code cannot atomically guarantee focus around asynchronous browser APIs, so a switch after a checkpoint cannot be eliminated. |
| Malformed extension messages | The content listener accepts only exact Analyze and Restore request shapes. | This does not authenticate a compromised extension environment. |
| Orphaned extension UI listeners | The extension-owned panel cleans its Escape listener and references when its exact node is removed. | A hostile page can affect its own DOM/CSS. |
| Silent or remote data exfiltration | The verifier rejects emitted assets containing `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource`, Worker construction, dynamic `import()`, external resource URL sinks, remote executable URLs, or secret-like patterns. | Static scanning covers specific patterns, not every possible runtime behavior. |
| Persistent background activity or external callers | The verifier rejects `background` and `externally_connectable`. | Popup code still needs review as beta work evolves. |
| Unwanted checkout mutation | Analysis is read-only except for the extension-owned findings panel. | A hostile page can still affect its own DOM/CSS. |

## Out of scope

This beta is not publish-ready. It has no browser-store distribution, real-site support, authentication, backend, telemetry, payment/account/cancellation handling, legal review, security audit, or consumer-protection guarantee.
