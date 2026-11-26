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
    // One byte of the data changed (always a real change, unlike swapping the last characters).
    const parts = sealed.split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = data[0]! ^ 0xff;
    expect(open(key, [...parts.slice(0, 3), data.toString('base64url')].join('.'))).toBeNull();
    expect(open(key, 'garbage')).toBeNull();
  });
});
