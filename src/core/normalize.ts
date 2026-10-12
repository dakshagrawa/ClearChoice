export function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function hasContentEditableAncestor(element: Element): boolean {
  return element.closest('[contenteditable]') !== null;
}

export function hasHiddenAncestor(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) return true;

  // Conservatively exclude hidden ancestors even when a child overrides visibility.
  try {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden'
        || style.visibility === 'collapse' || style.opacity === '0') return true;
    }
  } catch {
    // Unavailable computed styles must not turn unreadable page text into evidence.
    return true;
  }

  return false;
}

export function isElementVisible(element: Element): boolean {
  if (hasContentEditableAncestor(element) || hasHiddenAncestor(element)) return false;

  return normalizeVisibleText(element.textContent ?? '') !== '';
}

export function cssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current) {
    if (current.id) {
      const escape = globalThis.CSS?.escape ?? ((value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
      parts.unshift(`#${escape(current.id)}`);
      break;
    }

    const parent: HTMLElement | null = current.parentElement;
    const tag = current.tagName.toLowerCase();
    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const currentTag = current.tagName;
    const siblings: Element[] = Array.from(parent.children).filter(
      (sibling: Element) => sibling.tagName === currentTag,
    );
    const position = siblings.indexOf(current) + 1;
    parts.unshift(`${tag}:nth-of-type(${position})`);
    current = parent;
  }

  return parts.join(' > ');
}
