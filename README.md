# ClearChoice MVP

ClearChoice is an **unpublished, non-production Chromium Manifest V3 MVP**. It provides a local, user-initiated analysis of a mock checkout page served from `127.0.0.1`.

## Scope

- The content script is registered only for `http://127.0.0.1/*`.
- Open the extension popup and click **Analyze** to request analysis of an available local mock-checkout tab.
- The analysis reads visible page text and checked checkbox/radio labels, then displays informational findings in a dismissible panel.
- The current rules are documented in [docs/rule-catalog.md](docs/rule-catalog.md).

## Explicit non-goals and limits

This MVP does **not**:

- send network requests or transmit page data;
- access accounts, payment data, or cancellation flows;
- perform account, payment, cancellation, or checkout actions;
- modify checkout controls, selections, prices, forms, or page content (it only adds/removes its own findings panel);
- make legal, compliance, or consumer-protection determinations; or
- support Firefox, browser stores, publication, or real checkout sites.

Findings are heuristic notices, not facts or advice. See [PRIVACY.md](PRIVACY.md) and [docs/threat-model.md](docs/threat-model.md).

## Load locally in Chromium

1. Run `npm ci`.
2. Run `npm run build`.
3. In Chromium, open `chrome://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked** and select this repository's `dist/` directory.
6. Open a mock checkout at `http://127.0.0.1/...`, open the ClearChoice popup, and click **Analyze**.

`dist/` is a generated local unpacked-extension directory; it is not a store package.

## Create and inspect the local archive

```sh
npm run package:unpacked
unzip -l ClearChoice-mvp-unpacked.zip
```

The command rebuilds and verifies `dist/`, then creates `ClearChoice-mvp-unpacked.zip`. `manifest.json` is at the archive root, so extracting the archive yields a directory suitable for Chromium's **Load unpacked** flow. The ZIP is local-only and is not published or uploaded.

## Verification

```sh
npm test
npm run lint
npm run build
npm run e2e
npm run package:unpacked
unzip -l ClearChoice-mvp-unpacked.zip
```

Current reproducible evidence and limitations are in [docs/test-evidence.md](docs/test-evidence.md).