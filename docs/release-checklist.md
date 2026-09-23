# ClearChoice v0.2.0 release checklist

- [ ] `npm run check:release` and `npm audit --omit=dev` pass from a clean checkout.
- [ ] The source, built, and archived manifests declare exactly `storage`; `activeTab`, `scripting`, host, and optional permissions are absent.
- [ ] The release artifact contains no user-specific Tailscale hostname, secrets, remote executable code, service worker, or broad site permission; its emitted assets pass the static policy rejecting `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource`/`Worker` construction, dynamic `import()`, external absolute/protocol-relative HTML `src`, `href`, `action`, `formaction`, or `poster` values (quoted or unquoted), `srcset` values, CSS `url()` values, and supported DOM URL sinks (location, dot/bracket `href`/`src`/`action` assignments, and `setAttribute`, with quoted or template-literal values).
- [ ] The demo override is documented as a separate developer-only build; no user-specific host is required or included in release artifacts.
- [ ] Manual demo supports three controlled scenarios—clean one-time checkout, recurring charge, and preselected paid add-on—and renders only the expected evidence.
- [ ] The panel is keyboard-accessible, visually legible in light/dark pages, does not obscure primary checkout controls, and can be dismissed and restored by the user.
- [ ] Findings are grounded in exact visible page evidence and clearly say “possible”; no checkout form field, selection, navigation, or submission is modified.
- [ ] Documentation distinguishes **what was tested**, **what was not tested**, and **the future real-site beta boundary**.
