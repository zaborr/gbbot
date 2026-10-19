import { describe, expect, it } from 'vitest';
import { freeSlug } from './clone.js';

describe('cloning products', () => {
  it('gives copies a free link name', () => {
    const taken = new Set(['tea', 'tea-2']);
    expect(freeSlug('tea', taken)).toBe('tea-3');
    expect(freeSlug('tea', taken)).toBe('tea-4');
    expect(freeSlug('coffee', taken)).toBe('coffee');
    const long = 'a'.repeat(64);
    const copy = freeSlug(long, new Set([long]));
    expect(copy).toHaveLength(64);
    expect(copy.endsWith('-2')).toBe(true);
  });
});
