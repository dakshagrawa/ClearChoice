import { dedupeNestedTextFindings, makeFinding } from './dedupe';
import { cssPath, isElementVisible, normalizeVisibleText } from './normalize';
import type { Finding } from './types';

const RECURRING_SELECTOR = 'form, section, aside, label, p, span, div, li';
const recurringSignal = /(?:[$€£]\s*\d+(?:[.,]\d{1,2})?\s*(?:\/|per\s+)(?:month|week|year)|\b(?:billed|charged|renews?\s+automatically)\b[^.]{0,80}\b(?:every|monthly|weekly|annually|yearly|month|week|year)\b|\b(?:subscription|recurring payment|auto-renew)\b)/i;
const paidSignal = /(?:[$€£]\s*\d+(?:[.,]\d{1,2})?|\b(?:paid|premium|protection|membership)\b)/i;

const recurringTitle = 'Possible recurring charge';
const recurringExplanation =
  'This page includes language that may describe a charge that repeats. Check the schedule and amount before continuing.';
const addonTitle = 'Preselected paid option';
const addonExplanation =
  'This option is already selected and may add a cost. Review it before continuing.';

function hasHiddenAncestor(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) {
    return true;
  }

  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return true;
    }
  }

  return false;
}

function visibleText(element: Element): string {
  const text = Array.from(element.childNodes)
    .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? '';
      }
      if (node instanceof Element && !hasHiddenAncestor(node)) {
        return visibleText(node);
      }
      return '';
    })
    .join(' ');

  return normalizeVisibleText(text);
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
  if (control.labels?.length) {
    return control.labels[0] ?? null;
  }

  return control.closest('label');
}

export function detectRecurringCharges(root: Element): Finding[] {
  const findings = elementsIncludingRoot(root, RECURRING_SELECTOR)
    .filter(isElementVisible)
    .map((element) => ({ element, evidence: visibleText(element) }))
    .filter(({ evidence }) => evidence !== '' && recurringSignal.test(evidence))
    .map(({ element, evidence }) =>
      makeFinding(
        'recurring-charge',
        'notice',
        recurringTitle,
        recurringExplanation,
        evidence,
        cssPath(element),
      ),
    );

  return dedupeNestedTextFindings(findings);
}

export function detectPreselectedAddons(root: Element): Finding[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]'))
    .filter(
      (control) =>
        control.checked &&
        control.type !== 'hidden' &&
        !ignored(control) &&
        !hasHiddenAncestor(control),
    )
    .map((control) => ({ control, label: controlLabel(control) }))
    .filter((item): item is { control: HTMLInputElement; label: HTMLLabelElement } => item.label !== null)
    .filter(({ label }) => isElementVisible(label))
    .map(({ control, label }) => ({ control, label, evidence: visibleText(label) }))
    .filter(({ evidence }) => evidence !== '' && paidSignal.test(evidence))
    .map(({ control, evidence }) =>
      makeFinding('preselected-addon', 'notice', addonTitle, addonExplanation, evidence, cssPath(control)),
    );
}
