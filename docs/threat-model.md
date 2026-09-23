# ClearChoice v0.2.0 threat model

## System boundary

ClearChoice is a Chromium Manifest V3 MVP with a popup and a content script registered only for `http://127.0.0.1/*`. A user must click **Analyze** in the popup. The content script runs the two local heuristics and optionally renders a separate findings panel. A dismiss action is stored in `chrome.storage.local`.

## Assets and intended protections

| Asset / concern | MVP boundary |
| --- | --- |
| Page text and findings | Kept in the browser extension/page context. The release artifact must pass the static emitted-asset policy described below. |
| Accounts and credentials | Not accessed; no account permissions, login flows, or account actions exist. |
| Payment data and checkout actions | Not accessed or acted on; no payment, purchase, refund, subscription, or cancellation operation exists. |
| Page integrity | ClearChoice does not modify page controls, selections, prices, forms, or content. Its only DOM addition is its own dismissible findings panel. |
| Scope of execution | The manifest content script match is exactly `http://127.0.0.1/*`; no host permissions are declared. |
| User control | Analysis requires a popup click. Panel dismissal removes only ClearChoice UI and records a local dismissal flag. |

## Threats and mitigations

| Threat | MVP mitigation | Residual risk / limit |
| --- | --- | --- |
| Extension analyzes a real checkout site | Content script registration is limited to `127.0.0.1`; package validation rejects non-local content-script matches and host permissions. | A user can host arbitrary content locally. The MVP does not establish that local content is safe or genuine. |
| Silent or remote data exfiltration | The package verifier fail-closes emitted runtime assets containing `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource` or `Worker` construction, dynamic `import()`, external absolute/protocol-relative HTML `src`, `href`, `action`, `formaction`, or `poster` values (quoted or unquoted), `srcset` values, CSS `url()` values, supported DOM URL sinks (location, dot/bracket `href`/`src`/`action` assignments, and `setAttribute`, with quoted or template-literal values), remote executable URLs, or secret-like patterns. | This static policy checks these specific patterns only; it does not prove every browser/runtime networking behavior or future change is absent. |
| Excessive extension capabilities | Manifest validation requires exactly `storage`; it rejects `activeTab`, `scripting`, other permissions, optional permissions, background workers, external connections, remote executable URLs, and non-empty host grants. The automatically registered local content script receives popup messages without on-demand injection. | `chrome.storage.local` remains available solely for the dismissal flag. Future permission changes require review. |
| Unwanted checkout mutation | Analysis reads DOM text/control state and panel dismissal tests verify the checkbox remains checked. | The extension deliberately adds/removes its own panel. It does not prove immunity to every hostile page/CSS interaction. |
| Misleading detection result | Findings use `Possible` / `may` language and are documented as heuristics with false positives and negatives. | Heuristics can be wrong; they are not legal, billing, or compliance conclusions. |
| Persistent tracking | Only a local dismissal flag is stored through `chrome.storage.local`. | Browser/profile users can inspect or clear extension storage; this is not an account-backed preference system. |

## Out of scope

This MVP is not production- or publish-ready. It has no Firefox support, browser-store support, real-site support, authentication, backend, telemetry, payment handling, account handling, cancellation handling, legal review, security audit, or consumer-protection guarantee.