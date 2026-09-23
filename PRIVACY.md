# ClearChoice v0.2.0 Privacy Notice

ClearChoice is an unpublished Chromium private beta. It is not a published service or production privacy program.

## Access and data handling

The private-beta manifest declares exactly `activeTab`, `scripting`, and `storage`, with no host permissions, optional permissions, static content scripts, background worker, or external connections. `activeTab` is temporary access to the user-invoked active tab; it does not grant broad or persistent host access.

Task 1 defines that least-privilege manifest contract only. Current-tab script injection is not implemented yet. Controlled local checkout fixtures remain for internal testing but are not named in the manifest.

When analysis is enabled in a later task, it will examine visible text and qualifying checked checkbox/radio labels only after user invocation. A dismissed findings panel may be stored in `chrome.storage.local`; it is not used for tracking, analytics, synchronization, advertising, or profiling.

The release verifier rejects static package patterns for network APIs, remote executable URLs, secrets, dynamic imports, external resource URLs, and supported DOM URL sinks. This fail-closed static policy does not prove every possible browser/runtime networking behavior is absent.

## What ClearChoice does not access or do

- It does not have persistent access to any host, including the internal fixtures.
- It does not access accounts, credentials, or payment data.
- It does not initiate purchases, cancellations, refunds, subscriptions, or other checkout actions.
- It does not modify checkout choices or forms.
- It does not make legal or regulatory determinations.
