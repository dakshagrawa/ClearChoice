# ClearChoice v0.2.0

ClearChoice is an **unpublished, non-production Chromium Manifest V3 v0.2.0 release candidate**. It provides a local, user-initiated analysis of mock checkout pages served from `127.0.0.1`.

## Scope

- The release content script is registered only for `http://127.0.0.1/*`. `npm run build:demo` may add one exact HTTP Tailnet origin from the gitignored `.demo-origin.local` file to the separate `demo-dist/` output.
- The release manifest declares exactly the `storage` permission. It has no `activeTab`, `scripting`, host, or optional permissions: the automatically registered content script receives the popup's local message.
- Open the extension popup and click **Analyze** to request analysis of an available local mock-checkout tab.
- The analysis reads visible page text and checked checkbox/radio labels, then displays informational findings in a dismissible panel.
- The current rules are documented in [docs/rule-catalog.md](docs/rule-catalog.md).

## Explicit non-goals and limits

This MVP does **not**:

- include emitted runtime artifacts that violate the release verifier's static policy: `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `EventSource` or `Worker` construction, dynamic `import()`, external absolute/protocol-relative HTML `src`, `href`, `action`, `formaction`, or `poster` values (quoted or unquoted), `srcset` values, CSS `url()` values, or supported DOM URL sinks (location, dot/bracket `href`/`src`/`action` assignments, and `setAttribute`, with quoted or template-literal values);
- access accounts, payment data, or cancellation flows;
- perform account, payment, cancellation, or checkout actions;
- modify checkout controls, selections, prices, forms, or page content (it only adds/removes its own findings panel);
- make legal, compliance, or consumer-protection determinations; or
- support Firefox, browser stores, publication, or real checkout sites.

Findings are heuristic notices, not facts or advice. See [PRIVACY.md](PRIVACY.md) and [docs/threat-model.md](docs/threat-model.md).

The artifact policy is a fail-closed static check of emitted assets, not proof that every possible browser or runtime networking behavior is absent.

## Manual test in Chromium

1. Run `npm ci` and `npm run build` from the repository root.
2. In terminal A, run `npm run serve:fixtures` and leave it running.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `~/ClearChoice/dist`.
4. In terminal or browser B, visit one controlled scenario: `http://127.0.0.1:4173/checkout/clean`, `/checkout/recurring`, `/checkout/addon`, or `/checkout/mixed`. For a private Tailnet demo, put one exact HTTP Tailnet origin in `.demo-origin.local`, run `npm run build:demo`, and load `~/ClearChoice/demo-dist` instead.
5. Open the ClearChoice extension popup and click **Analyze**.
6. Stop the local mock-checkout server with **Ctrl+C** in terminal A when finished.

The release content script is registered only for the local `127.0.0.1` mock target. A demo-only Tailnet match is read from the ignored local file and emitted only to `demo-dist/`; it is not included in `dist/` or the ZIP.

`dist/` is a generated local unpacked-extension directory; it is not a store package.

## Create and inspect the local archive

```sh
npm run package:unpacked
unzip -l ClearChoice-v0.2.0-unpacked.zip
```

The command rebuilds and verifies `dist/`, then creates `ClearChoice-v0.2.0-unpacked.zip`. `manifest.json` is at the archive root, so extracting the archive yields a directory suitable for Chromium's **Load unpacked** flow. The ZIP is local-only and is not published or uploaded.

## Verification

```sh
npm test
npm run lint
npm run build
npm run e2e
npm run package:unpacked
unzip -l ClearChoice-v0.2.0-unpacked.zip
```

Current reproducible evidence and limitations are in [docs/test-evidence.md](docs/test-evidence.md).