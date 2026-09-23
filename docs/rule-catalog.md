# ClearChoice v0.2.0 rule catalog

All findings are informational heuristics. Their machine-readable severity is either `notice` or `info`: stronger recurring-charge evidence and preselected paid-option evidence emit `notice`, while bare subscription language emits `info`. They run only after the user clicks **Analyze** on the local `http://127.0.0.1/*` mock checkout target. They are not legal, compliance, or billing determinations.

## R1 — Possible recurring charge

**Candidate elements:** visible `form`, `section`, `aside`, `label`, `p`, `span`, `div`, and `li` elements, including the analysis root when it matches.

**Signal:** visible text matching at least one of:

- a currency amount with `/` or `per` followed by `month`, `week`, or `year` (for example, `$12 per month`) (`notice`);
- `billed`, `charged`, or `renews automatically`, followed within 80 non-period characters by a cadence such as `every`, `monthly`, `weekly`, `annually`, `yearly`, `month`, `week`, or `year` (`notice`); or
- `subscription`, `recurring payment`, or `auto-renew` without a preceding stronger signal (`info`).

**Output:** `Possible recurring charge` with the candidate's visible text as evidence and the severity shown above. A candidate containing an email, payment card/PAN or masked card, account/bank/routing number, CVV, or security-code text is discarded whole rather than redacted or retained. Nested matching candidates are reduced so the enclosing matching element is not reported when it contains another matching candidate.

**Known false positives:** policy copy, educational text, historical invoices, non-purchase memberships, free trials described with recurring language, and unrelated visible text can match. A match does not prove a charge exists or will recur.

**Known false negatives:** wording without the listed keywords/cadences, non-textual price disclosures, content in unsupported DOM contexts, or hidden content can be missed. Text is inspected only in the listed element types.

## R2 — Preselected paid option

**Candidate controls:** checked `input[type="checkbox"]` and `input[type="radio"]` elements with an associated label (via `labels` or an enclosing `label`).

**Exclusions:** hidden controls; controls or ancestors that are `[hidden]`, `aria-hidden="true"`, `display: none`, or `visibility: hidden`; controls inside `[data-clearchoice-ignore]`; labels that are not visible; and labels containing an email, payment card/PAN or masked card, account/bank/routing number, CVV, or security-code text. Sensitive candidates are discarded whole rather than redacted or retained.

**Signal:** normalized visible label text containing either a currency amount using `$`, `€`, or `£`, or one of `paid`, `premium`, `protection`, or `membership`.

**Output:** `Preselected paid option` with the full visible label text as evidence and `notice` severity.

**Known false positives:** preselected no-cost options whose label uses one of the keywords, included benefits, labels that mention a price only for comparison, or controls selected by the page for a non-purchase purpose. A match does not establish that an option costs money.

**Known false negatives:** paid options without the listed currencies/keywords, controls other than checkbox/radio inputs, unlabeled controls, unchecked options, and hidden or ignored controls.

## General rule limits

- Whitespace is normalized before matching.
- The MVP does not inspect or alter form submissions, prices, account state, payment instruments, or cancellations.
- The panel is separate extension UI. Dismissing it removes only that panel and stores a local dismissal flag; it does not change a checkout control.
- Rule results are limited to the local mock-checkout MVP and are not suitable as advice or a decision engine.