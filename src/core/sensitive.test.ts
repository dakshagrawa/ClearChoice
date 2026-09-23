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
});