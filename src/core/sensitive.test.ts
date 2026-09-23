import { describe, expect, it } from 'vitest';

import { hasSensitiveDisplayData } from './sensitive';

describe('hasSensitiveDisplayData', () => {
  it('recognizes a displayed CVV2 value', () => {
    expect(hasSensitiveDisplayData('CVV2: 123')).toBe(true);
  });

  it('recognizes a displayed security-code value', () => {
    expect(hasSensitiveDisplayData('security code 123')).toBe(true);
  });

  it('does not treat bare security-code wording as displayed data', () => {
    expect(hasSensitiveDisplayData('A security code is needed to sign in')).toBe(false);
  });

  it.each([
    '**** 4242',
    'Card **** 4242',
    'Card:**** 4242',
    'Card ending:•••• 4242',
  ])('recognizes a masked card with an allowed prefix context: %s', (text) => {
    expect(hasSensitiveDisplayData(text)).toBe(true);
  });

  it.each([
    'SKU-xxxx 4242',
    'https://example.test/xxxx 4242',
    'note/xxxx 4242',
  ])('does not mistake ordinary punctuation text for a masked card: %s', (text) => {
    expect(hasSensitiveDisplayData(text)).toBe(false);
  });
});