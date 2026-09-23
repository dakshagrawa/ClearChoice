# ClearChoice 0.3.0-beta.1 rule catalog

These rules are advisory-only heuristics for **English consumer checkout** pages in the private opt-in beta. A notice is not a conclusion that a site is deceptive, legal, illegal, compliant, safe, or unsafe. Testers must compare any notice with the visible page text.

## R1 — Possible recurring charge

**Signal:** visible text includes a currency amount with `/` or `per` followed by `month`, `week`, or `year`; `billed`, `charged`, or `renews automatically` near a cadence; or weaker language such as `subscription`, `recurring payment`, or `auto-renew`.

**Output:** `Possible recurring charge`, with `notice` for stronger recurring-charge evidence and `info` for bare subscription language.

**Known false positives:** policy copy, educational text, historical invoices, non-purchase memberships, free-trial descriptions, and unrelated visible text can match. A match does not prove a charge exists or will recur.

**Known false negatives:** wording outside the listed patterns, non-textual disclosures, hidden content, and unsupported DOM contexts can be missed.

## R2 — Preselected paid option

**Signal:** a visible checked checkbox or radio control has an associated visible label containing a currency amount or words such as `paid`, `premium`, `protection`, or `membership`.

**Output:** `Preselected paid option` with `notice` severity.

**Known false positives:** included benefits, no-cost options using a keyword, comparison prices, and non-purchase selections can match. A match does not establish that an option costs money.

**Known false negatives:** paid options without the listed currencies or keywords, unlabeled controls, unchecked options, hidden controls, and non-checkbox/radio controls can be missed.

## Data and action limits

The rules do not inspect typed form or `contenteditable` values. Static visible text may be transiently inspected while evaluating a candidate, but a candidate containing email, payment-card/PAN or masked-card, account/bank/routing number, CVV, or security-code text is discarded whole rather than redacted or retained. ClearChoice does not alter controls, prices, forms, payments, accounts, cancellations, or checkout submission.
