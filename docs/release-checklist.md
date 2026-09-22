# ClearChoice v0.2.0 release checklist

- [ ] `npm run check:release` and `npm audit --omit=dev` pass from a clean checkout.
- [ ] The release artifact contains no user-specific Tailscale hostname, secrets, remote executable code, service worker, or broad site permission; its emitted assets pass the static policy rejecting `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource`/`Worker` construction, dynamic `import()`, external absolute/protocol-relative HTML or CSS URLs, and external DOM URL sinks.
- [ ] The demo override is documented as a separate developer-only build; no user-specific host is required or included in release artifacts.
- [ ] Manual demo supports three controlled scenarios—clean one-time checkout, recurring charge, and preselected paid add-on—and renders only the expected evidence.
- [ ] The panel is keyboard-accessible, visually legible in light/dark pages, does not obscure primary checkout controls, and can be dismissed and restored by the user.
- [ ] Findings are grounded in exact visible page evidence and clearly say “possible”; no checkout form field, selection, navigation, or submission is modified.
- [ ] Documentation distinguishes **what was tested**, **what was not tested**, and **the future real-site beta boundary**.
