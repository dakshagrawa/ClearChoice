# ClearChoice 0.3.0-beta.1 Private-Beta Privacy Notice

ClearChoice is an unpublished Chromium private beta. It is not a published service or production privacy program.

## Access and data handling

The private-beta manifest declares exactly `activeTab`, `scripting`, and `storage`, plus one `_execute_action` shortcut (`Ctrl+Shift+Y`), with no host permissions, optional permissions, static content scripts, background worker, or external connections. `activeTab` is temporary access to the user-invoked active tab; it does not grant broad or persistent host access.

Task 2 current-tab injection is implemented as current beta work, not release-ready functionality. It begins after a user invokes Analyze or Restore for the active current tab, processes visible text and qualifying checked checkbox/radio labels locally in the injected page context, and returns only a typed status plus integer finding count to the popup. Controlled local checkout fixtures remain for internal testing but are not named in the manifest.

Analyze rechecks the chosen tab before injection and after awaited injection. If a tab switch is observed at those checkpoints, it cancels instead of messaging the old target. An extension cannot atomically lock focus between those checks and asynchronous browser operations, so no claim is made that every micro-race can be prevented.

A dismissed findings-panel state may be stored in `chrome.storage.local`; it is not used for tracking, analytics, synchronization, advertising, or profiling. After local human attestation, the separate manual active-tab QA runner emits—but never writes—a data-free JSON marker. The reviewer manually saves that local self-attestation outside the repository; it records only pass/fail, the fixed literal `local-human-attestation`, current Git commit, and manifest hash, with no URL, title, DOM text, form value, or finding. It is not cryptographic proof of a human gesture.

The release verifier rejects static package patterns for network APIs, remote executable URLs, secrets, dynamic imports, external resource URLs, and supported DOM URL sinks. This fail-closed static policy does not prove every possible browser/runtime networking behavior is absent.

See [the beta scope](docs/beta-scope.md) and [beta release checklist](docs/beta-release-checklist.md) for the beta boundary and outstanding gates.

## What ClearChoice does not access or do

- It does not have persistent access to any host, including the internal fixtures.
- It does not access accounts, credentials, or payment data.
- It does not initiate purchases, cancellations, refunds, subscriptions, or other checkout actions.
- It does not modify checkout choices or forms.
- It does not make legal or regulatory determinations.
