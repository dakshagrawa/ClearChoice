# Architecture and Safety Boundary

ClearChoice is a local-only Chromium Manifest V3 private-beta implementation for user-initiated analysis. It is current beta work, not release-ready.

## Safety boundaries

- Analysis is user initiated. Analyze and Restore query `{ active: true, currentWindow: true }`, target that current tab, inject the local `dist/content.js` payload, and recheck the target after awaited injection before messaging it.
- If a tab switch is observed at either pre-injection or post-injection checkpoint, the request is cancelled. Browser extension code cannot atomically guarantee focus between those checks and asynchronous injection or messaging, so a switch immediately after a checkpoint remains an unavoidable race.
- `dist/content.js` is deliberately emitted by Vite as the programmatic injection payload; it is not a static `content_scripts` artifact.
- Popup responses contain only a typed status and integer finding count. Findings, evidence, selectors, URL, title, timestamps, page HTML, and form data remain in the page context.
- Content-message requests are closed schemas: only exact Analyze and Restore objects are accepted, and additional fields are rejected.
- The panel owns only its DOM node, Escape listener, and a removal observer that checks removal of that exact node. It does not inspect host content or run analysis automatically.
- Release artifacts must pass a static emitted-asset policy that rejects `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource`/`Worker` construction, dynamic `import()`, external absolute/protocol-relative HTML `src`, `href`, `action`, `formaction`, or `poster` values (quoted or unquoted), `srcset` values, CSS `url()` values, and supported DOM URL sinks (location, dot/bracket `href`/`src`/`action` assignments, and `setAttribute`, with quoted or template-literal values); this does not prove all possible runtime networking is absent.
- No account access or account actions.
- No payment data access or payment actions.
- No cancellation actions.
- No legal determinations.
- No modification of checkout pages beyond the extension-owned findings panel.

See [beta scope](beta-scope.md) and the [beta release checklist](beta-release-checklist.md) for the private-beta boundary and outstanding release gates.
