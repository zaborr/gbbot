import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { webLinks } from './webLinks.js';

const base = { DATABASE_URL: 'postgres://x', BOT_TOKEN: '1:abc', JWT_SECRET: 'x'.repeat(32) };

describe('links on every domain', () => {
  it('main first, then the extra and customer-only ones', () => {
    const env = loadEnv({ ...base, EXTRA_DOMAINS: 'reserve.example.org', CUSTOMER_ONLY_DOMAINS: 'shop.example.net' });
    expect(webLinks(env, 'https://main.example.com/', '/s/gb')).toEqual([
      'https://main.example.com/s/gb',
      'https://reserve.example.org/s/gb',
      'https://shop.example.net/s/gb',
    ]);
  });

  it('can leave the main domain out, and still reads the old names', () => {
    const env = loadEnv({ ...base, WEB_DOMAINS: 'shop.example.net', WEB_KEY_MAIN_LINK: 'false' });
    expect(webLinks(env, 'https://main.example.com', '/x')).toEqual(['https://shop.example.net/x']);
    const renamed = loadEnv({ ...base, EXTRA_DOMAINS: 'reserve.example.org', LINKS_SHOW_MAIN_DOMAIN: 'false' });
    expect(webLinks(renamed, 'https://main.example.com', '/x')).toEqual(['https://reserve.example.org/x']);
  });
});
