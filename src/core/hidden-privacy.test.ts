import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildFindingBatch } from '../content/candidates';
import { classifyCheckoutContext } from './context';
import { detectPreselectedAddons, detectRecurringCharges } from './detector';
import { isElementVisible } from './normalize';

const hiddenStyles = [
  'display: none',
  'visibility: hidden',
  'visibility: collapse',
  'opacity: 0',
];
const recurringTags = ['form', 'section', 'aside', 'label', 'p', 'span', 'div', 'li'];

function checkout(hidden: string): HTMLElement {
  // Only fixed, synthetic test markup is passed to this fixture.
  document.body.innerHTML = `<main>
    <aside>Order summary — Subtotal: $24</aside><button>Place order</button>
    ${hidden}
    <section>Visible plan $8 per month</section>
    <label><input type="checkbox" checked>Visible protection $5</label>
  </main>`;
  return document.querySelector('main')!;
}

function findings(root: Element) {
  return [...detectRecurringCharges(root), ...detectPreselectedAddons(root)];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
});

describe('CSS-hidden checkout privacy', () => {
  it('never maps a display-none ancestor finding into a scan batch', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const root = checkout('<div style="display:none"><p>Hidden plan $12 per month</p></div>');
    expect(classifyCheckoutContext(root)).toBe('supported');
    const batch = await buildFindingBatch(findings(root), 'scan-hidden-ancestor');
    expect(batch.findings.map((finding) => finding.screenedExcerpt)).toEqual([
      'Visible plan $8 per month', 'Visible protection $5',
    ]);
    expect(JSON.stringify(batch)).not.toContain('Hidden plan');
  });

  it.each(hiddenStyles)('excludes all recurring selectors and paid controls under %s', (style) => {
    const candidates = recurringTags.map((tag) => `<${tag}>Hidden plan $12 per month</${tag}>`).join('');
    const root = checkout(`<div style="${style}"><div>${candidates}
      <label><input type="checkbox" checked>Hidden protection $9</label>
      <label><input type="radio" checked>Hidden premium $7</label>
    </div></div>`);
    expect(classifyCheckoutContext(root)).toBe('supported');
    expect(findings(root).map((finding) => finding.evidence)).toEqual([
      'Visible plan $8 per month', 'Visible protection $5',
    ]);
  });

  it.each(hiddenStyles)('excludes hidden direct text while preserving surrounding visible evidence: %s', (style) => {
    const root = checkout(`<section>Visible recurring plan $6 per month
      <b style="${style}">Hidden direct text $99 per month</b>
    </section>`);
    expect(findings(root).map((finding) => finding.evidence)).toEqual([
      'Visible recurring plan $6 per month', 'Visible plan $8 per month', 'Visible protection $5',
    ]);
  });

  it.each(hiddenStyles)('never hashes hidden candidates or maps them into DTOs: %s', async (style) => {
    vi.stubGlobal('crypto', webcrypto);
    const digest = vi.spyOn(webcrypto.subtle, 'digest');
    const root = checkout(`<div style="${style}"><p>Hidden plan $12 per month</p>
      <label><input type="checkbox" checked>Hidden protection $9</label></div>`);
    const batch = await buildFindingBatch(findings(root), 'scan-hidden-css');
    expect(batch.findings.map((finding) => finding.screenedExcerpt)).toEqual([
      'Visible plan $8 per month', 'Visible protection $5',
    ]);
    expect(digest).toHaveBeenCalledTimes(2);
    for (const call of digest.mock.calls) {
      expect(new TextDecoder().decode(call[1] as BufferSource)).not.toContain('Hidden');
    }
  });

  it('conservatively excludes visibility overrides beneath a hidden ancestor', () => {
    const root = checkout('<div style="visibility:hidden"><p style="visibility:visible">Hidden plan $12 per month</p></div>');
    expect(findings(root).map((finding) => finding.evidence)).toEqual([
      'Visible plan $8 per month', 'Visible protection $5',
    ]);
  });

  it.each(hiddenStyles)('checks ancestors outside the detector root: %s', (style) => {
    checkout(`<div style="${style}"><section id="hidden-root">Hidden plan $12 per month
      <label><input type="checkbox" checked>Hidden protection $9</label></section></div>`);
    expect(findings(document.querySelector('#hidden-root')!)).toEqual([]);
  });

  it('checks the document element without requiring an element parent', () => {
    checkout('');
    expect(isElementVisible(document.documentElement)).toBe(true);
    document.documentElement.style.opacity = '0';
    expect(findings(document.body)).toEqual([]);
  });

  it('accepts visible recurring candidates for every detector selector', () => {
    const root = checkout(recurringTags.map((tag, index) => `<${tag}>Visible choice $${index + 20} per month</${tag}>`).join(''));
    expect(detectRecurringCharges(root).map((finding) => finding.evidence)).toEqual([
      ...recurringTags.map((_, index) => `Visible choice $${index + 20} per month`),
      'Visible plan $8 per month',
    ]);
    expect(detectPreselectedAddons(root).map((finding) => finding.evidence)).toEqual(['Visible protection $5']);
  });

  it.each(hiddenStyles)('uses computed stylesheet rules, not just inline styles: %s', (style) => {
    const root = checkout(`<style>.hidden-checkout-fixture { ${style} }</style>
      <div class="hidden-checkout-fixture"><p>Hidden plan $12 per month</p>
        <label><input type="checkbox" checked>Hidden protection $9</label></div>`);
    expect(findings(root).map((finding) => finding.evidence)).toEqual([
      'Visible plan $8 per month', 'Visible protection $5',
    ]);
  });

  it.each(hiddenStyles)('screens a hidden checked control even with a separate visible label: %s', (style) => {
    const root = checkout(`<div style="${style}"><input id="hidden-control" type="checkbox" checked></div>
      <label for="hidden-control">Hidden protection $9</label>`);
    expect(detectPreselectedAddons(root).map((finding) => finding.evidence)).toEqual(['Visible protection $5']);
  });

  it('fails closed when computed style cannot be obtained', () => {
    const root = checkout('');
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => { throw new Error('unavailable'); });
    expect(isElementVisible(root)).toBe(false);
    expect(findings(root)).toEqual([]);
  });
});
