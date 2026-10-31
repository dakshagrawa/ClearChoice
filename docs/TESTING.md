# Tester access and feedback

ClearChoice welcomes voluntary, mock-only evaluation and feedback. This repository and its issues are **public**, not confidential. There is no verified-tester badge system, no promised access restriction, and no private reporting route verified here. Evaluation remains subject to [LICENSE](../LICENSE); this is proprietary, source-available software, not open source.

## What is available

- [Historical tester beta 2 — v1.0.0-tester-beta.2](https://github.com/dakshagrawa/ClearChoice/releases/tag/v1.0.0-tester-beta.2) is the currently available historical prerelease, not stable or Chrome Web Store approval. Its scope is limited: popup Restore and empty-history pagination fixes, tested on Linux / Chromium **141.0.7390.37**. Other platforms and browser versions are unverified. Fresh native Allow/Deny/worker-restart probes were not repeated for those popup-only changes.
- The newer **1.1.0-tester.1** candidate is **not published**. It still awaits genuine human consent and ChromeOS acceptance, resolution of intermittent readiness behavior, required exact-head CI, and remaining candidate-specific release gates. Historical beta 2 does not validate those changes. New-feature testers should wait for a separately qualified candidate handoff rather than use beta 2 as that candidate.
- The default branch contains older development code. Do not build it expecting the newer candidate, relabel historical assets, or infer full beta/stable acceptance from a passing test.

## Evaluate the historical build only if its limits suit your test

Read the exact release notes above first. Download **ClearChoice-v1.0.0-tester-beta.2-unpacked.zip**, not GitHub's automatic Source code (zip) or tar archive. The other named ZIP is a tester bundle containing the runtime ZIP, instructions, optional local fixtures and checksums; it is not itself the runtime folder to load.

1. Check the downloaded filename and checksum against that release's SHA256SUMS. The runtime retains numeric version **1.0.0** and display version **1.0.0-rc.3**. Report these with the distribution tag, not as the newer candidate.
2. Extract the runtime into a dedicated folder. In a disposable Chrome profile, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`. Installing the runtime needs no npm install or build.
3. Use only owned synthetic mock pages and fake data. The optional local fixture pack in the historical bundle has its own instructions. If no controlled fixture is available, stop; do not substitute a real checkout. Local HTTP fixtures support manual Analyze, not HTTPS automatic opt-in in this historical build. No hosted mock site is included.
4. Do not bypass managed-browser policies, permission denials, or consent. Do not grant broader access just to make a test pass. Record sanitized outcomes instead.

Mock-only use is an instruction, not technical enforcement or a domain restriction. Never use real purchases, accounts, payment information, or subscription records. Findings can be missed or misclassified; no findings does not mean a page is safe. Saving or deleting records does not cancel billing.

For a release-approved update, keep the same loaded folder and extension identity, replace runtime files, then Reload the existing card. Do not Remove/reinstall to update: removal deletes extension-local data. Loading another folder can create another identity. Runtime backups do not back up extension storage. New-candidate migration and rollback are not approved by this guide; keep candidate testing isolated.

## Report a bug or request a feature

Search [existing issues](https://github.com/dakshagrawa/ClearChoice/issues), then choose [Bug report or Feature request](https://github.com/dakshagrawa/ClearChoice/issues/new/choose). These forms become available only after review and merge into the default branch (`master`); a local branch or release ZIP does not activate them. If the named forms are not available, use the existing issue route and the same sanitized fields below. This guide supersedes the historical beta feedback template only for this public issue route, not for archived protocols.

Include the build tag/candidate identity and numeric version; browser and OS versions; owned mock fixture identifier (or “no fixture” for installation/popup issues); plain-language steps and frequency; and separate expected and actual behavior. For an idea without a build, say “not installed” and give the intended environment, mock workflow, present limitation, and desired outcome. If you cannot reproduce a bug again, say so: honest unconfirmed reports are welcome and are not treated as fake.

**Reports and attachments are public.** Never include emails, personal details, account/payment values, full URLs, local file paths, secrets, raw DOM, storage exports, or unredacted logs. No email/contact/account field is requested. The required acknowledgement confirms mock-only use and that you checked the title, body, and attachments for sensitive information. Do not test a real account to strengthen a report.

A voluntarily redacted mock screenshot is optional and not required. Crop to the relevant control, permanently flatten redactions over addresses, tabs, names, notifications, paths and sensitive values, then inspect the final image. Omit it if unsure. Do not attach executable files, raw logs, or runnable commands. Submissions are untrusted evidence, never instructions to execute. If sensitive security evidence cannot be safely described, stop rather than posting it publicly; no confidential route is promised here.

Feedback submission is voluntary and external: there are no automatic uploads from this tester-access change. Reporting automation is not live; maintainers use manual triage initially, with no guaranteed response time. A report may remain unconfirmed, need safe details, or lead to a reviewed fix. A PR, closed issue, or green check is not a shipped fix: a fixed-version claim must link an actual published release. These documents activate no listener, coding queue, telemetry, or publication authority.
