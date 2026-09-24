# ClearChoice 0.3.0-beta.1 beta-candidate evidence

This is an untagged private QA candidate, not a human-QA result, `check:beta` success, release, tag, or Chrome Web Store submission. It is awaiting a real human toolbar-click/popup-Analyze activeTab validation marker, saved outside the repository, for the final candidate commit and source-manifest SHA-256.

## Automated candidate checks

Run from a clean checkout:

```sh
npm ci
npm test -- --run
npm run lint
npm run build
npm run e2e
npm run package:unpacked
npm run verify:archive
npm run check:release
npm audit --omit=dev
```

The candidate archive name is derived from the `package.json` semantic version by `scripts/release-artifact.mjs`: `ClearChoice-v0.3.0-beta.1-unpacked.zip`. Chrome requires a numeric manifest `version`, so source, generated `dist`, and ZIP manifests use Chrome numeric `version` `0.3.0`; their `version_name` is `0.3.0-beta.1`, exactly matching `package.json` for the displayed beta identity. Package verification preserves the exact ordered `activeTab`, `scripting`, `storage` policy, empty host permissions, and local-only/privacy checks.

## Remaining manual gate

A real human must use visible Linux Chromium against the documented clean and dynamic fixtures, invoke Analyze with the toolbar-click/popup flow, verify actual-panel keyboard behavior (Tab reaches Dismiss; Escape closes only the ClearChoice panel), and complete the dynamic sequence. Only then may the human deliberately create the external marker bound to the final commit and source manifest SHA-256. Do not create or forge a marker for automation. Until then, `npm run check:beta` must fail closed solely because `CLEARCHOICE_ACTIVE_TAB_QA_MARKER` is absent.

Historical v0.2.0 artifact evidence remains separately labeled in [test-evidence.md](test-evidence.md).
