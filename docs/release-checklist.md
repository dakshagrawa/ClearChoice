# ClearChoice v1 release checklist

- [ ] `npm test -- --run`, `npm run lint`, `npm run build`, `npm run e2e`, `npm run package:unpacked`, and `npm audit --omit=dev` pass from a clean checkout.
- [ ] The release artifact contains no user-specific Tailscale hostname, secrets, remote executable code, network API, service worker, or broad site permission.
- [ ] The demo manifest is limited to the static fixture origin; a private developer override can add one exact origin locally without being committed or packaged.
- [ ] Manual demo supports three controlled scenarios—clean one-time checkout, recurring charge, and preselected paid add-on—and renders only the expected evidence.
- [ ] The panel is keyboard-accessible, visually legible in light/dark pages, does not obscure primary checkout controls, and can be dismissed and restored by the user.
- [ ] Findings are grounded in exact visible page evidence and clearly say “possible”; no checkout form field, selection, navigation, or submission is modified.
- [ ] Documentation distinguishes **what was tested**, **what was not tested**, and **the future real-site beta boundary**.
