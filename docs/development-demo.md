# Developer-only demo override

The v0.2.0 release build has one content-script match: `http://127.0.0.1/*`.

For a private development demonstration only, create the ignored `.demo-origin.local` file with one exact HTTP Tailnet origin, then run:

```sh
npm run build:demo
```

The override accepts one `http://…ts.net` origin and emits only to the separate `demo-dist/` directory. It is not committed, is not read by the release build, and is not included in `ClearChoice-v0.2.0-unpacked.zip`. Do not place a user host in release documentation, source configuration, or release artifacts.

To return to the release artifact, run `npm run build` followed by `npm run package:unpacked`.