# Architecture and Safety Boundary

ClearChoice is a local-only Chromium Manifest V3 MVP for user-initiated analysis on mock checkout pages only.

## Safety boundaries

- Analysis is user initiated and runs only after the popup queries `{ active: true, currentWindow: true }`, injects the local `dist/content.js` payload into that one tab, and messages that same tab. No inactive tab is inspected, injected, or messaged.
- `dist/content.js` is deliberately emitted by Vite as the programmatic injection payload; it is not a static `content_scripts` artifact.
- Popup responses contain only a typed status and integer finding count. Findings, evidence, selectors, URL, title, timestamps, page HTML, and form data remain in the page context.
- Release artifacts must pass a static emitted-asset policy that rejects `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource`/`Worker` construction, dynamic `import()`, external absolute/protocol-relative HTML `src`, `href`, `action`, `formaction`, or `poster` values (quoted or unquoted), `srcset` values, CSS `url()` values, and supported DOM URL sinks (location, dot/bracket `href`/`src`/`action` assignments, and `setAttribute`, with quoted or template-literal values); this does not prove all possible runtime networking is absent.
- No account access or account actions.
- No payment data access or payment actions.
- No cancellation actions.
- No legal determinations.
- No modification of checkout pages.

> make no claim beyond MVP
