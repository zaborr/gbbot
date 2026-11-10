import { describe, expect, it } from 'vitest';
import { open, seal, secretKey } from './secretBox.js';

describe('secret box', () => {
  const key = secretKey({ JWT_SECRET: 'a-jwt-secret-of-some-length' });

  it('opens what it sealed', () => {
    const sealed = seal(key, '123:ABC');
    expect(sealed).not.toContain('123:ABC');
    expect(open(key, sealed)).toBe('123:ABC');
  });

  it('refuses another key or tampered data', () => {
    const sealed = seal(key, '123:ABC');
    expect(open(secretKey({ JWT_SECRET: 'x', BOTS_KEY: 'other' }), sealed)).toBeNull();
    expect(open(key, `${sealed.slice(0, -2)}AA`)).toBeNull();
    expect(open(key, 'garbage')).toBeNull();
  });
});
