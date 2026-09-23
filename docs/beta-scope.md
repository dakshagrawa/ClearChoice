# ClearChoice private-beta scope

ClearChoice private beta runs only when a person explicitly clicks Analyze from the extension popup. It uses Chromium's temporary active-tab permission to inspect visible English checkout-page evidence locally in that one tab. It does not run automatically, use broad host access, store page data, transmit page data, access accounts, process payments, or change checkout behavior.

## Supported boundary

The planned private beta is limited to English-language consumer checkout pages. ClearChoice will provide advisory notices based on visible evidence only; it does not determine whether a site or practice is deceptive, illegal, compliant, safe, or unsafe.

## Explicit exclusions

This scope excludes:

- Chrome Web Store submission, listing, upload, or publication;
- always-on monitoring, automatic scanning, or persistent host access;
- telemetry, analytics, accounts, cloud services, remote configuration, or page-data transmission;
- automated tests against real sites;
- legal, compliance, or consumer-protection determinations; and
- checkout mutation, including changing form values, controls, navigation, totals, submission, cancellation, or purchase behavior.

## Release boundary

This document defines future private-beta requirements only. v0.2.0 remains the mock-only baseline until every beta gate passes. The historical v0.2.0 release evidence remains in [release-checklist.md](release-checklist.md); the future beta gates are tracked in [beta-release-checklist.md](beta-release-checklist.md).
