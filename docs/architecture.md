# Architecture and Safety Boundary

ClearChoice is a local-only Chromium Manifest V3 MVP for user-initiated analysis on mock checkout pages only.

## Safety boundaries

- Analysis is user initiated.
- The MVP operates on mock checkout pages only.
- Release artifacts must pass a static emitted-asset policy that rejects `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource`/`Worker` construction, dynamic `import()`, external absolute/protocol-relative HTML or CSS URLs, and external DOM URL sinks; this does not prove all possible runtime networking is absent.
- No account access or account actions.
- No payment data access or payment actions.
- No cancellation actions.
- No legal determinations.
- No modification of checkout pages.

> make no claim beyond MVP
