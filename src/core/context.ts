import { normalizeVisibleText } from './normalize';
import type { ContextStatus } from './types';

const ACTION_CUE = /\b(?:checkout|place\s+order|complete\s+order|pay\s+now|order\s+total)\b/i;
const SUMMARY_CUE = /\b(?:order\s+summary|subtotal|total|shipping|payment)\b/i;
const ACCOUNT_SETTINGS_CUE = /\baccount\s+settings\b/i;
const ignoredAncestors = [
  '[data-clearchoice-panel]',
  '[hidden]',
  '[aria-hidden="true"]',
  'script',
  'style',
  'template',
  'article',
  'input',
  'textarea',
  'select',
  'option',
  '[contenteditable="true"]',
].join(', ');

function isVisibleStaticText(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent || parent.closest(ignoredAncestors)) return false;

  for (let current: Element | null = parent; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }

  return true;
}

export function classifyCheckoutContext(root: Element): ContextStatus {
  let hasActionCue = false;
  let hasSummaryCue = false;
  let hasAccountSettingsCue = false;
  const textNodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  for (let textNode = textNodes.nextNode() as Text | null; textNode; textNode = textNodes.nextNode() as Text | null) {
    if (!isVisibleStaticText(textNode)) continue;
    const text = normalizeVisibleText(textNode.textContent ?? '');
    if (text === '') continue;
    hasActionCue ||= ACTION_CUE.test(text);
    hasSummaryCue ||= SUMMARY_CUE.test(text);
    hasAccountSettingsCue ||= ACCOUNT_SETTINGS_CUE.test(text);
  }

  return hasActionCue && hasSummaryCue && !hasAccountSettingsCue ? 'supported' : 'unsupported';
}
