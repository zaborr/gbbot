import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { authenticate } from '../auth/middleware.js';

/** Set by Caddy (overwriting whatever the client sent) on the customer-only domains. */
export const CUSTOMER_SITE_HEADER = 'X-Gb-Site';

/**
 * What a session opened with a customer's web key may use: the customer side of
 * its GB and nothing else. Whoever gives a key could otherwise act as that person
 * anywhere (their web access, their GBs as organiser…).
 */
const KEY_SESSION_PATHS: Array<[methods: string[] | '*', path: RegExp]> = [
  ['*', /^\/api\/(shop|categories|products|cart|orders)(\/|$)/],
  [['GET'], /^\/api\/(shops|bot|web\/banner|images\/[^/]+)$/],
  [['GET'], /^\/api\/me\/notices$/],
  // Their phrase: shown (the official web knows it, a fake one does not), and
  // chosen there if they have none; the route keeps it from being changed.
  [['GET', 'PUT'], /^\/api\/me\/security-phrase$/],
  [['PUT'], /^\/api\/me\/language$/],
  [['POST'], /^\/api\/me\/how-to-seen$/],
];

export function keySessionMay(method: string, path: string): boolean {
  if (method === 'OPTIONS' || method === 'HEAD') return true;
  return KEY_SESSION_PATHS.some(([methods, re]) => (methods === '*' || methods.includes(method)) && re.test(path));
}

/**
 * - A web key session: only the paths above.
 * - The customer-only domains (WEB_DOMAINS): no sign-in but the key, and no
 *   session other than a key session (an admin token taken there does not work).
 */
export const sessionScope = createMiddleware<AppBindings>(async (c, next) => {
  const path = c.req.path;
  const customerSite = c.req.header(CUSTOMER_SITE_HEADER) === 'customer';
  if (customerSite && path.startsWith('/api/auth') && path !== '/api/auth/key') {
    throw new ApiError(403, 'customer_site', 'Only customers can sign in here');
  }
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return next();
  let ck: string | undefined;
  try {
    ck = (await authenticate(header.slice(7), c.get('env'), c.get('db'))).ck;
  } catch {
    // A bad token: the route's own check answers (401), or it is a public route.
    if (customerSite) throw ApiError.unauthorized('Invalid or expired session');
    return next();
  }
  if (ck === undefined) {
    if (customerSite) throw new ApiError(403, 'customer_site', 'Only customers can sign in here');
    return next();
  }
  if (!keySessionMay(c.req.method, path)) {
    throw ApiError.forbidden('Not available when signed in with a web key');
  }
  return next();
});
