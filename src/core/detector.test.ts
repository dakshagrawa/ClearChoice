import { describe, expect, it } from 'vitest';

import {
  detectPreselectedAddons,
  detectRecurringCharges,
} from './detector';
import { normalizeVisibleText } from './normalize';

function root(html: string): HTMLElement {
  const fixture = document.createElement('div');
  fixture.innerHTML = html;
  return fixture;
}

describe('normalizeVisibleText', () => {
  it('folds whitespace and trims', () => {
    expect(normalizeVisibleText(' \n  billed\t  every   month \r ')).toBe(
      'billed every month',
    );
  });
});

describe('detectRecurringCharges', () => {
  it('finds a visible monthly amount with neutral evidence', () => {
    const findings = detectRecurringCharges(root('<section>Plan costs $12.99 per month</section>'));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'recurring-charge',
      severity: 'notice',
      reason: 'price-cadence',
      title: 'Possible recurring charge',
      explanation:
        'This page includes language that may describe a charge that repeats. Check the schedule and amount before continuing.',
      evidence: 'Plan costs $12.99 per month',
    });
  });

  it('finds visible automatic-renew language', () => {
    const findings = detectRecurringCharges(root('<aside>Membership renews automatically every year.</aside>'));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toBe('Membership renews automatically every year.');
    expect(findings[0]?.reason).toBe('renewal-language');
  });

  it('does not flag a one-time price without recurrence evidence', () => {
    expect(detectRecurringCharges(root('<section>One-time purchase: $12</section>'))).toEqual([]);
  });

  it('reports bare subscription language as informational evidence', () => {
    const findings = detectRecurringCharges(root('<section>Compare subscription options</section>'));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'info',
      reason: 'subscription-language',
      evidence: 'Compare subscription options',
    });
  });

  it('excludes hidden recurring-charge text', () => {
    const findings = detectRecurringCharges(root('<section hidden>$12 per month</section>'));

    expect(findings).toEqual([]);
  });

  it('deduplicates nested matching text', () => {
    const findings = detectRecurringCharges(root('<section><div><span>$12 per month</span></div></section>'));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toBe('$12 per month');
  });

  it('keeps the most specific recurring signal when its ancestor has unrelated visible text', () => {
    const findings = detectRecurringCharges(root(
      '<div><section>$12 per month</section><label><input checked type="checkbox"> Protection $5</label></div>',
    ));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toBe('$12 per month');
  });

  it('keeps sibling recurring controls as separate findings in DOM order', () => {
    const findings = detectRecurringCharges(root(`
      <form>
        <label><input type="radio" name="plan"> Basic $4 per month</label>
        <label><input type="radio" name="plan"> Plus $8 per month</label>
      </form>
    `));

    expect(findings.map((finding) => finding.evidence)).toEqual([
      'Basic $4 per month',
      'Plus $8 per month',
    ]);
  });

  it('uses deterministic IDs and no duplicate explanations for equivalent analysis', () => {
    const html = '<section>Membership renews automatically every year.</section>';

    const first = detectRecurringCharges(root(html));
    const second = detectRecurringCharges(root(html));

    expect(first.map((finding) => finding.id)).toEqual(second.map((finding) => finding.id));
    expect(new Set(first.map((finding) => finding.explanation)).size).toBe(first.length);
  });
});

describe('detectPreselectedAddons', () => {
  it('finds a checked paid checkbox', () => {
    const findings = detectPreselectedAddons(root('<label><input type="checkbox" checked> Add protection for $5</label>'));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'preselected-addon',
      severity: 'notice',
      reason: 'checked-paid-control',
      title: 'Preselected paid option',
      explanation: 'This option is already selected and may add a cost. Review it before continuing.',
      evidence: 'Add protection for $5',
    });
  });

  it('finds a checked paid radio', () => {
    const findings = detectPreselectedAddons(root('<label><input type="radio" checked> Premium delivery (£8)</label>'));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toBe('Premium delivery (£8)');
  });

  it('excludes an unchecked paid checkbox', () => {
    expect(detectPreselectedAddons(root('<label><input type="checkbox"> Protection $5</label>'))).toEqual([]);
  });

  it('excludes a checked free email checkbox', () => {
    expect(detectPreselectedAddons(root('<label><input type="checkbox" checked> Email me updates</label>'))).toEqual([]);
  });

  it('excludes a checked ignored control', () => {
    expect(detectPreselectedAddons(root('<label><input type="checkbox" checked data-clearchoice-ignore> Protection $5</label>'))).toEqual([]);
  });

  it('keeps two distinct checked paid controls with the same label text', () => {
    const findings = detectPreselectedAddons(root(`
      <label><input type="checkbox" checked> Protection $5</label>
      <label><input type="checkbox" checked> Protection $5</label>
    `));

    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(2);
  });

  it('does not borrow a paid label from a sibling control', () => {
    const findings = detectPreselectedAddons(root(`
      <input id="free" type="checkbox" checked>
      <label for="paid">Protection $5</label>
      <input id="paid" type="checkbox">
    `));

    expect(findings).toEqual([]);
  });

  it('uses the exact paid control label as evidence', () => {
    const findings = detectPreselectedAddons(root(`
      <label for="protection">Add protection for $5</label>
      <input id="protection" type="checkbox" checked>
      <p>Other checkout copy is not evidence.</p>
    `));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      evidence: 'Add protection for $5',
      reason: 'checked-paid-control',
    });
  });
});
