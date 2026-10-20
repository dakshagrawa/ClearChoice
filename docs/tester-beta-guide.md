# ClearChoice tester beta: 1.0.0-rc.3

This candidate is for Chrome beta testing, not a stable release or a published store extension. Testers supply the human testing phase; no human pass or stable-production approval is claimed. Notices are advisory: false positives and false negatives are possible. A finding is not a confirmed subscription or a legal, safety, compliance, or deceptive-site conclusion.

## Install and remove

1. Use the supplied runtime extension ZIP and accompanying candidate receipt. The intended handoff includes `verification.json` and `SHA256SUMS`; use those supplied files to identify the actual candidate and its verification results. This guide supplies no hashes or passing results. If those files are missing or disagree with the download, ask the person who supplied it to resolve the identity before testing.
2. Extract the runtime ZIP. Its root contains `manifest.json` and emitted runtime assets.
3. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`. Follow your organization's browser policies; if loading is blocked, stop and report that limitation.
4. Confirm the extension card is **ClearChoice**, then open it from Chrome's extensions menu. This candidate's extracted `manifest.json` has numeric `version` **1.0.0** and display `version_name` **1.0.0-rc.3**; compare those with the supplied receipt. A numeric Chrome version of 1.0.0 is expected, not a stable-approval claim. The popup itself need not display the candidate version. No Node, npm install, source checkout, or build is needed to install or use the extension.

To uninstall, open `chrome://extensions`, choose ClearChoice → **Remove**, and confirm. Chrome removes the extension's local stored data on removal; delete the extracted files and downloaded ZIPs separately if no longer wanted. While keeping the extension installed, delete unwanted history records and confirmed subscriptions through their respective controls. History deletion or expiry does not delete confirmed subscriptions. Removing a stored record, the extension, or its files **does not cancel actual billing**.

## Optional local mock fixtures

The separate `ClearChoice-tester-fixtures.zip` supplies local mock pages without the extension source or dependencies. The extracted pack's server was exercised on Node 24.21.0: all seven routes returned their exact fixture files, invalid routes/methods were rejected, and the owned server stopped cleanly. This verifies the fixture pack, not extension behavior or Chrome consent. Installation of ClearChoice itself does not require this pack or Node.

When supplied, extract the pack. It should contain a root folder `ClearChoice-tester-fixtures/`, with `scripts/serve-fixtures.mjs` and seven HTML files under `fixtures/`. For this optional server only, use Node **24**. In a terminal, change into that extracted root (adjust the location to where you extracted it), then run:

```sh
cd /path/to/ClearChoice-tester-fixtures
node scripts/serve-fixtures.mjs
```

No package install or build is needed. The server binds only `127.0.0.1`; with no `PORT` override its port is **4173**. Open these exact addresses in Chrome:

| Fixture identifier | URL | Manual check |
| --- | --- | --- |
| clean | http://127.0.0.1:4173/checkout/clean | Zero findings |
| recurring | http://127.0.0.1:4173/checkout/recurring | Positive recurring notice |
| addon | http://127.0.0.1:4173/checkout/addon | Positive paid-add-on notice |
| mixed | http://127.0.0.1:4173/checkout/mixed | Combined notices |
| dynamic-beta | http://127.0.0.1:4173/checkout/dynamic-beta | Re-analyze after mock content changes |
| marketing-article | http://127.0.0.1:4173/unsupported/marketing-article | Unsupported page |
| account-settings | http://127.0.0.1:4173/unsupported/account-settings | Unsupported page |

Stop the server with **Ctrl+C** in its terminal. If it cannot start, report the sanitized error category; do not change browser policies or use a live checkout as a substitute.

Local HTTP/localhost fixtures allow manual **Analyze**, but **Enable detection for this site** is intentionally unavailable. Automatic opt-in needs a valid HTTPS hostname; loopback IPs and localhost do not qualify. These local checks therefore do not prove opt-in or Chrome consent behavior. No hosted fake fixture has been approved or created. An optional HTTPS opt-in check is available only if an independently supplied mock HTTPS fixture is provided later. Do not use real accounts or payments, broaden permissions, or work around this restriction.

## Short mock-only checklist

Use synthetic values only; do not enter personal, account, or payment information. The mixed/dynamic fixtures deliberately include prefilled fake private-looking controls to test exclusion and host integrity; leave them synthetic and never substitute real data.

- Run **Analyze** on the positive, zero, and unsupported fixtures above. Zero and unsupported cases should leave no empty findings panel; a zero result should have no Cancellation Help footer. Check that Analyze and **Restore** leave mock checkout controls unchanged and submit nothing.
- Where a retained finding is available, open **Review as subscription**. Inspect the draft; ambiguous values may be blank. **Mark reviewed** only marks an observation reviewed. Only explicit **Save subscription** confirms it and creates a local subscription. Automatic observations also remain unconfirmed until explicit Save; manual local fixtures do not exercise automatic observation.
- Create a synthetic manual subscription, read it, edit it, reopen the popup to check persistence, then delete it. Use an invented label such as “Mock service” and no identifying notes. If a create acknowledgement is lost, inspect the list before retrying: retrying can create a duplicate.
- Check history deletion and retention selection: 7, 30, 90 days, or Never (default 30). Confirmed subscriptions remain until separately deleted. Never disables age expiry, not the 500-observation cap. Selecting retention alone does not prove elapsed-time expiry.
- Navigate with Tab, Shift+Tab, Enter, and Space as appropriate. Check visible focus, expandable explanations, readable controls, and light/dark appearance. Report clipping or controls you cannot reach.
- Treat Cancellation Help as optional advisory navigation, not cancellation. Arbitrary merchant names do not select provider help; source-origin eligibility determines available links. Do not visit real accounts or billing pages for this checklist.

## Privacy, limits, and feedback

Data stays local: no telemetry, extension uploads, accounts, backend, or sync is added. Automatic detection is off by default; optional site access is a revocable grant for one exact HTTPS origin. Manual Analyze uses temporary active-tab access. Unsupported and sensitive pages are excluded. Removing site access in Chrome revokes browser access; permission presence alone does not prove detection is enabled. Help navigation requires a separate user click and is browser navigation, not an extension upload.

Existing automated native evidence is limited to Chromium 141 on Linux. Other Chrome versions, operating systems, and subjective usability remain unverified here; consult the supplied final receipt for actual candidate coverage. Mocked or pregranted automation does not establish genuine Chrome Allow/Deny consent behavior. Historical candidate test counts are not evidence for this candidate. These documents do not change existing stable/human-marker gates or authorize publication or store submission.

Feedback is voluntary. Use [the current sanitized report template](tester-beta-feedback.md), through the channel agreed with the person who supplied the candidate. The extension does not collect or send reports.
