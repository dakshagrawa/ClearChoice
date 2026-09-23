import { describe, expect, it } from 'vitest';

import { classifyCheckoutContext } from './context';

function root(html: string): HTMLElement {
  const fixture = document.createElement('div');
  fixture.innerHTML = html;
  return fixture;
}

describe('classifyCheckoutContext', () => {
  it('supports visible static checkout action and commerce summary cues', () => {
    expect(classifyCheckoutContext(root(`
      <main>
        <h1>Checkout</h1>
        <aside>Order summary <span>Subtotal: $24</span></aside>
        <button>Place order</button>
      </main>
    `))).toBe('supported');
  });

  it('rejects account settings and marketing articles without both checkout cue classes', () => {
    expect(classifyCheckoutContext(root(`
      <article><h1>How to pay now for subscriptions</h1><p>Order total guidance for members.</p></article>
    `))).toBe('unsupported');
    expect(classifyCheckoutContext(root(`
      <main><h1>Account settings</h1><p>Payment preferences, shipping addresses, order total, and Pay now help.</p></main>
    `))).toBe('unsupported');
  });

  it('ignores extension, hidden, inert, form-owned, and all contenteditable content', () => {
    const privateValues = 'private@example.test 4111111111111111 confidential textarea select editable';
    const editableValue = 'EDITABLE_CONTEXT_ONLY Checkout Order summary Pay now';
    const fixture = root(`
      <aside data-clearchoice-panel>Place order Order summary Total</aside>
      <section hidden>Checkout Subtotal Pay now</section>
      <script>Checkout Order summary Place order</script>
      <style>.checkout::after { content: 'Order summary'; }</style>
      <template>Checkout Total Pay now</template>
      <input value="${privateValues}" placeholder="Checkout Order summary Pay now" autocomplete="cc-number" aria-description="Order total">
      <textarea>${privateValues} Checkout Order summary Pay now</textarea>
      <select><option>${privateValues} Checkout Order summary Pay now</option></select>
      <div contenteditable="true">${privateValues} Checkout Order summary Pay now</div>
      <div contenteditable="plaintext-only">${editableValue}</div>
      <div contenteditable>${editableValue}</div>
      <div contenteditable="false">${editableValue}</div>
    `);

    expect(classifyCheckoutContext(fixture)).toBe('unsupported');
    expect(JSON.stringify(classifyCheckoutContext(fixture))).not.toContain('private@example.test');
    expect(JSON.stringify(classifyCheckoutContext(fixture))).not.toContain('4111111111111111');
    expect(JSON.stringify(classifyCheckoutContext(fixture))).not.toContain('EDITABLE_CONTEXT_ONLY');
  });

  it('supports static checkout text surrounding a plaintext-only editable field', () => {
    const editableValue = 'EDITABLE_CONTEXT_ONLY Checkout Order summary Pay now';
    const fixture = root(`
      <main>
        <h1>Checkout</h1>
        <div contenteditable="plaintext-only">${editableValue}</div>
        <aside>Order summary <span>Subtotal: $24</span></aside>
        <button>Place order</button>
      </main>
    `);

    expect(classifyCheckoutContext(fixture)).toBe('supported');
  });

  it('does not use static text containing sensitive-looking displayed values as checkout context cues', () => {
    const fixture = root(`
      <main>
        <section>Checkout — Order summary — Place order. sensitive-context@example.test. Card 4111-1111-1111-1111. Account number: 123456789.</section>
      </main>
    `);

    expect(classifyCheckoutContext(fixture)).toBe('unsupported');
  });

  it('keeps static checkout context analyzable when security-code wording has no displayed value', () => {
    const fixture = root(`
      <main>
        <h1>Checkout</h1>
        <aside>Order summary — A security code is needed to sign in.</aside>
        <button>Place order</button>
      </main>
    `);

    expect(classifyCheckoutContext(fixture)).toBe('supported');
  });
});
