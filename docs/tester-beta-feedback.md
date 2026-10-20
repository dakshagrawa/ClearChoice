# ClearChoice 1.0.0-rc.3 tester beta feedback

Feedback is voluntary and sent separately through the channel agreed with the person who supplied the candidate. No recipient or issue tracker is prescribed here. The extension adds no telemetry or report uploads. See the [tester guide](tester-beta-guide.md) for installation and mock-only checks.

Copy this template and fill it with synthetic, non-sensitive descriptions only:

```text
Extension name and Chrome's displayed numeric version (if shown):
Candidate version from supplied verification.json:
Runtime ZIP filename and SHA-256 from supplied SHA256SUMS:
OS and version:
Chrome/browser name and version:
Fixture identifier: clean | recurring | addon | mixed | dynamic-beta |
                    marketing-article | account-settings | no fixture (installation/UI)
Area: installation | Analyze | review/Save | Mark reviewed | subscription CRUD |
      history/retention | keyboard | light/dark | uninstall | other
Non-sensitive reproduction steps:
Expected behavior:
Actual behavior:
Frequency: every attempt | intermittent (occurrences/attempts) | once
```

Copy only candidate identity fields and the archive hash from the supplied receipt/checksum files, not the full files. If missing, say “not supplied”; do not guess hashes or verification results. A candidate receipt is not a payment receipt. Describe results in your own words, such as “zero findings showed a panel,” without quoting the page or stored records.

Do **not** include URLs (including real site or help destinations), page text, titles, HTML, form values, browsing history, personal details, account/payment/order information, merchant names, subscription amounts or notes, storage exports, logs, or screenshots. Use the fixture identifier instead of its URL. This template excludes all screenshots, including unsanitized screenshots. Do not reproduce a problem on a real account or payment checkout to make a report.

If an independently supplied mock HTTPS fixture becomes available later, use only its non-sensitive fixture identifier and describe permission/status outcomes without its address. Local HTTP fixtures cannot test automatic opt-in. Neither a report nor mock/pregranted automation establishes genuine human Chrome consent approval or stable readiness. Findings remain advisory and may be false positives or miss issues; saving or deleting local subscription records never changes actual billing.
