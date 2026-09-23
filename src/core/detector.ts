import { dedupeNestedTextFindings, makeFinding } from './dedupe';
import { cssPath, isElementVisible, normalizeVisibleText } from './normalize';
import type { Finding, FindingReason, Severity } from './types';

const RECURRING_SELECTOR = 'form, section, aside, label, p, span, div, li';
const priceCadenceSignal = /[$€£]\s*\d+(?:[.,]\d{1,2})?\s*(?:\/|per\s+)(?:month|week|year)/i;
const renewalSignal = /\b(?:billed|charged|renews?\s+automatically)\b[^.]{0,80}\b(?:every|monthly|weekly|annually|yearly|month|week|year)\b/i;
const subscriptionSignal = /\b(?:subscription|recurring payment|auto-renew)\b/i;
const paidSignal = /(?:[$€£]\s*\d+(?:[.,]\d{1,2})?|\b(?:paid|premium|protection|membership)\b)/i;

const recurringTitle = 'Possible recurring charge';
const recurringExplanation =
  'This page includes language that may describe a charge that repeats. Check the schedule and amount before continuing.';
const addonTitle = 'Preselected paid option';
const addonExplanation =
  'This option is already selected and may add a cost. Review it before continuing.';

function hasHiddenAncestor(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) return true;

  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
  }

  return false;
}

function visibleText(element: Element): string {
  const text = Array.from(element.childNodes)
    .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (node instanceof Element && !isExcludedTextElement(node) && !hasHiddenAncestor(node)) return visibleText(node);
      return '';
    })
    .join(' ');

  return normalizeVisibleText(text);
}

function isExcludedTextElement(element: Element): boolean {
  return element.matches('script, style, template, input, textarea, select, option, [contenteditable="true"]');
}

function elementsIncludingRoot(root: Element, selector: string): Element[] {
  return [
    ...(root.matches(selector) ? [root] : []),
    ...Array.from(root.querySelectorAll(selector)),
  ];
}

function ignored(control: HTMLInputElement): boolean {
  return Boolean(control.closest('[data-clearchoice-ignore]'));
}

function controlLabel(control: HTMLInputElement): HTMLLabelElement | null {
  if (control.labels?.length) return control.labels[0] ?? null;
  return control.closest('label');
}

function recurringReason(evidence: string): { reason: FindingReason; severity: Severity } | null {
  if (priceCadenceSignal.test(evidence)) return { reason: 'price-cadence', severity: 'notice' };
  if (renewalSignal.test(evidence)) return { reason: 'renewal-language', severity: 'notice' };
  if (subscriptionSignal.test(evidence)) return { reason: 'subscription-language', severity: 'info' };
  return null;
}

function inDomOrder(left: Element, right: Element): number {
  if (left === right) return 0;
  return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

export function detectRecurringCharges(root: Element): Finding[] {
  const candidates = elementsIncludingRoot(root, RECURRING_SELECTOR)
    .filter((element) => !isExcludedTextElement(element))
    .filter(isElementVisible)
    .map((element) => ({ element, evidence: visibleText(element) }))
    .map(({ element, evidence }) => ({ element, evidence, match: recurringReason(evidence) }))
    .filter((candidate): candidate is { element: Element; evidence: string; match: { reason: FindingReason; severity: Severity } } => candidate.match !== null)
    .sort((left, right) => inDomOrder(left.element, right.element));

  return dedupeNestedTextFindings(candidates
    .filter(({ element }) => !candidates.some((candidate) => element !== candidate.element && element.contains(candidate.element)))
    .map(({ element, evidence, match }) => makeFinding(
      'recurring-charge',
      match.reason,
      match.severity,
      recurringTitle,
      recurringExplanation,
      evidence,
      cssPath(element),
    )));
}

export function detectPreselectedAddons(root: Element): Finding[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]'))
    .filter((control) => control.checked && control.type !== 'hidden' && !ignored(control) && !hasHiddenAncestor(control))
    .map((control) => ({ control, label: controlLabel(control) }))
    .filter((item): item is { control: HTMLInputElement; label: HTMLLabelElement } => item.label !== null)
    .filter(({ label }) => isElementVisible(label))
    .map(({ control, label }) => ({ control, evidence: visibleText(label) }))
    .filter(({ evidence }) => evidence !== '' && paidSignal.test(evidence))
    .map(({ control, evidence }) => makeFinding(
      'preselected-addon',
      'checked-paid-control',
      'notice',
      addonTitle,
      addonExplanation,
      evidence,
      cssPath(control),
    ));
}
