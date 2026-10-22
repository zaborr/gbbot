import { describe, expect, it } from 'vitest';
import { hit, ruleFor } from './rateLimit.js';

describe('rate limits', () => {
  it('picks the rule by request', () => {
    expect(ruleFor('GET', '/api/products').name).toBe('read');
    expect(ruleFor('POST', '/api/auth/telegram').name).toBe('login');
    expect(ruleFor('POST', '/api/orders/abc/payment').name).toBe('payment');
    expect(ruleFor('POST', '/api/orders/abc/manual-payment').name).toBe('payment');
    expect(ruleFor('POST', '/api/cart/items').name).toBe('write');
  });

  it('allows the limit per minute, then asks to wait until the window ends', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(hit('t|a', 3, now)).toBe(0);
    expect(hit('t|a', 3, now + 10_000)).toBe(50);
    // Another client is counted apart, and the window starts again later.
    expect(hit('t|b', 3, now)).toBe(0);
    expect(hit('t|a', 3, now + 60_000)).toBe(0);
  });
});
