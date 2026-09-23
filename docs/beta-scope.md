# ClearChoice private-beta scope

ClearChoice private beta runs only on Linux Chromium when a person explicitly invokes Analyze from the extension popup. Its required `check:beta` manual-QA marker gate is also Linux-only: it deliberately validates the opened marker descriptor through Linux `/proc/self/fd` and fails closed with a platform-specific diagnostic on macOS and Windows. It uses Chromium's temporary active-tab permission to briefly inspect visible English checkout-page evidence locally in that one tab. It excludes typed form and `contenteditable` values, and suppresses sensitive-looking static candidates from context cues, findings, and evidence. It does not run automatically, use broad host access, store page data, transmit page data, process payments, or change checkout behavior.

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
