export function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function isElementVisible(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

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
