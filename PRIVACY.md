# ClearChoice MVP Privacy Notice

ClearChoice is a local, unpublished Chromium MVP for mock checkout pages at `http://127.0.0.1/*` only.

## Data handling

When the user clicks **Analyze**, the content script examines visible text and qualifying checked checkbox/radio labels in the local page to generate findings. The result is sent only between the extension popup and its content script through Chromium's local extension messaging.

The MVP has no network API usage or remote service. It does not transmit page content, findings, account information, payment information, or cancellation information to ClearChoice or any third party.

## Local persistence

If the user dismisses the findings panel, ClearChoice records that dismissal using `chrome.storage.local`. This local flag prevents the panel from being rendered again after a reload. The MVP does not use the flag for tracking, advertising, profiling, synchronization, or analytics.

## What ClearChoice does not access or do

- It is registered only for `http://127.0.0.1/*`, not real checkout sites.
- It does not access accounts or account credentials.
- It does not access, collect, or act on payment data.
- It does not initiate or perform cancellation, purchase, refund, subscription, or other checkout actions.
- It does not modify checkout choices or forms.
- It does not make legal or regulatory determinations.

This notice describes the current MVP only. ClearChoice is not production-ready, has no Firefox or browser-store release, and must not be represented as a published privacy program or legal assurance.