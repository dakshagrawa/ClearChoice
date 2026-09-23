import { describe, expect, it } from 'vitest';

import { hasSensitiveDisplayData } from './sensitive';

describe('hasSensitiveDisplayData', () => {
  it('recognizes CVV2 as security-code-like displayed data', () => {
    expect(hasSensitiveDisplayData('CVV2: 123')).toBe(true);
  });
});