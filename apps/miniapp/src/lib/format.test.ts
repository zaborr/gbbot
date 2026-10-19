import { describe, expect, it } from 'vitest';
import { formatPrice, pluralize } from './format.js';

describe('formatPrice', () => {
  it('renders fiat as major units with the ISO code', () => {
    expect(formatPrice(1999, 'USD')).toBe('19.99 USD');
    expect(formatPrice(500, 'EUR')).toBe('5.00 EUR');
  });
});

describe('pluralize', () => {
  it('selects singular and plural forms', () => {
    expect(pluralize(1, 'item', 'items')).toBe('1 item');
    expect(pluralize(3, 'item', 'items')).toBe('3 items');
  });
});
