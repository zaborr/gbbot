import type { Env } from '../config/env.js';

/**
 * The same page on every domain people may use: the main one (unless
 * LINKS_SHOW_MAIN_DOMAIN=false and there are others), the extra ones (they
 * serve everything) and the customer-only ones. The first is the link; the
 * rest go under "if it does not open, try…".
 */
export function webLinks(env: Env, mainOrigin: string, path: string): string[] {
  const others = [...(env.EXTRA_DOMAINS ?? []), ...(env.WEB_DOMAINS ?? [])];
  const main = mainOrigin.replace(/\/+$/, '');
  const origins = [...(env.WEB_KEY_MAIN_LINK === false && others.length > 0 ? [] : [main]), ...others.map((d) => `https://${d}`)];
  return [...new Set(origins)].map((origin) => `${origin}${path}`);
}
