# Working on ClearChoice

ClearChoice is a TypeScript Manifest V3 extension for local checkout advice and subscription review. Use this file with `README.md`, `PRIVACY.md`, `CONTRIBUTING.md`, and the relevant documents under `docs/`.

## Establish the checkout

- Check the branch, working tree, and remotes before editing. Preserve unrelated changes and existing evidence artifacts.
- This checkout targets `release/v1-production`. The GitHub default branch may contain older code; do not apply its behavior or release status to this branch.
- Use the current `package.json`, `manifest.json`, and source as the implementation contract. Historical plans and release notes are not current acceptance evidence.

## Repository map

- `src/core/`: classification, detection, normalization, and sensitive-data screening.
- `src/content/`: document observation and the extension-owned panel.
- `src/worker/`: authorization, grants, badges, and serialized storage operations.
- `src/shared/`: message schemas, finding DTOs, models, storage, and the bundled guide catalog.
- `src/popup/`: popup controls, review history, and subscriptions.
- `tests/` and colocated `*.test.ts`: unit and package-policy regressions.
- `e2e/`: packaged Chromium integration and accessibility checks.
- `scripts/`: build, packaging, archive verification, fixtures, and release gates.

## Commands

Use Node 24, as required by `package.json` and `.nvmrc`, with npm and the committed lockfile. For a clean dependency installation, use `npm ci`; avoid dependency churn during unrelated work.

```sh
npm test -- --run --maxWorkers=2
npm run lint
npm exec -- tsc --noEmit
npm run build
npm run e2e -- --workers=1
```

The native test suite can require a headful Chromium display and Linux window-manager tools. Follow `.github/workflows/release-candidate.yml` for the supported CI environment. Report missing prerequisites instead of dropping assertions or counting unexecuted tests as passed.

For an explicitly requested candidate package:

```sh
npm run package:unpacked
npm run verify:archive
```

`package:unpacked` rebuilds the candidate. Never rebuild or repackage after artifact-bound human acceptance. Dependency audits contact the configured npm registry; run `npm audit --omit=dev` and `npm audit` when dependency or release verification is in scope.

## Privacy and authorization invariants

- Keep processing local. Do not add telemetry, remote configuration, uploads, accounts, or remote executable code as an incidental change.
- Manual Analyze uses temporary `activeTab` authorization. Automatic observation requires explicit, revocable, exact-origin permission and a separate application grant.
- Preserve strict sender, top-frame, document, origin, nonce, and grant-generation checks. Recheck authorization at queued write boundaries, including receipt replay.
- Keep storage mutations serialized and trusted-context storage inaccessible to content scripts.
- Do not collect typed field values, raw checkout URLs, HTML, selectors, or payment/account data. Discard whole sensitive candidates; preserve screening at producer, transport, and storage boundaries.
- Automatic findings are unconfirmed review items. Only explicit user actions create confirmed subscriptions.
- Do not modify checkout controls or automate purchases, cancellations, refunds, or form submission. Provider help links require deliberate user navigation.

## Verification and releases

- Add a regression for changed behavior and run the affected suite before broader checks. Permission, storage, and lifecycle changes also need packaged-browser evidence.
- Use controlled fixtures and synthetic data, never live accounts, purchases, or payment details. Label pregranted permissions and automated native input as synthetic evidence, not human consent.
- Keep popup controls keyboard-accessible and verify constrained layouts in both themes when UI changes.
- Build, tests, CI, human acceptance, publication, and store approval are separate gates. Do not forge QA markers, weaken gates, or resume stopped human QA without authorization.
- Keep source commit, manifest, archive digest, and acceptance evidence bound to the same candidate. Preserve existing published tags and assets.
- Pushes, merges, releases, and store submissions require explicit authorization and the applicable verified gates. A passing local check does not authorize them.

## Licensing and contributions

`LICENSE` is proprietary and source-available, not an open-source license. Preserve its notices, third-party rights, and the explicit contributor-permission workflow in `CONTRIBUTING.md`. Do not replace the license, infer permission from a submitted PR, or redistribute third-party material without checking its terms.
