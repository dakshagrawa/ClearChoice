# ClearChoice v0.2.0 threat model

## System boundary

ClearChoice is an unpublished Chromium Manifest V3 private beta with a popup. Its generated manifest declares exactly `activeTab`, `scripting`, and `storage`, and `host_permissions: []`. It declares no static content script, optional permission, background worker, or external connection. `activeTab` grants only temporary access to the active tab after user invocation. Task 1 defines this contract; it does not inject into the current tab yet.

Controlled local fixtures remain available for internal testing, but their host is not in the manifest and receives no persistent extension access.

## Assets and intended protections

| Asset / concern | Private-beta boundary |
| --- | --- |
| Page text and findings | Future access requires user invocation and is temporary to the active tab. The package must pass the static emitted-asset policy below. |
| Scope of execution | No host permissions or static content scripts; no broad, persistent, or optional host grant. |
| Accounts, credentials, payment data | Not accessed; no account permissions, login flows, or checkout actions exist. |
| Local persistence | `chrome.storage.local` is limited to the dismissible findings-panel state. |

## Threats and mitigations

| Threat | Private-beta mitigation | Residual risk / limit |
| --- | --- | --- |
| Broad or persistent host access | Manifest validation requires the ordered `activeTab`, `scripting`, `storage` set and empty host permissions; it rejects optional grants and all content scripts. | A later injection task must preserve user invocation and active-tab scope. |
| Silent or remote data exfiltration | The verifier rejects emitted assets containing `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource`, Worker construction, dynamic `import()`, external resource URL sinks, remote executable URLs, or secret-like patterns. | Static scanning covers specific patterns, not every possible runtime behavior. |
| Persistent background activity or external callers | The verifier rejects `background` and `externally_connectable`. | Popup code still needs review as beta work evolves. |
| Unwanted checkout mutation | No injection is implemented in Task 1. Future analysis must remain read-only except for its own findings UI. | A hostile page can still affect its own DOM/CSS. |

## Out of scope

This beta is not publish-ready. It has no browser-store distribution, real-site support, authentication, backend, telemetry, payment/account/cancellation handling, legal review, security audit, or consumer-protection guarantee.
