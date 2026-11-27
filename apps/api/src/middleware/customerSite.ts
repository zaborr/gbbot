import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { authenticate } from '../auth/middleware.js';
import { customerOnly, type SessionClaims } from '../auth/jwt.js';

/** Set by Caddy (overwriting whatever the client sent) on the customer-only domains. */
export const CUSTOMER_SITE_HEADER = 'X-Gb-Site';

/**
 * What a session opened with a customer's web key may use: the customer side of
 * its GB and nothing else. Whoever gives a key could otherwise act as that person
 * anywhere (their web access, their GBs as organiser…).
 */
const KEY_SESSION_PATHS: Array<[methods: string[] | '*', path: RegExp]> = [
  ['*', /^\/api\/(shop|categories|products|cart|orders)(\/|$)/],
  [['GET'], /^\/api\/(shops|bot|web\/banner|web\/config|images\/[^/]+)$/],
  [['GET'], /^\/api\/me\/notices$/],
  // Their phrase: shown (the official web knows it, a fake one does not), and
  // chosen there if they have none; the route keeps it from being changed.
  [['GET', 'PUT'], /^\/api\/me\/security-phrase$/],
  [['PUT'], /^\/api\/me\/language$/],
  [['POST'], /^\/api\/me\/how-to-seen$/],
  // Their own web account (made, password, Telegram confirmed).
  [['GET', 'POST'], /^\/api\/me\/account$/],
  [['PUT'], /^\/api\/me\/account\/password$/],
  [['POST'], /^\/api\/me\/account\/confirm$/],
  // "Log in with Telegram" (to confirm their Telegram or prove it for a new password).
  [['POST'], /^\/api\/(auth\/telegram\/start|web\/telegram\/result)$/],
];

/** The ways in on a customer-only domain: a web key, or a customer's web account. */
const CUSTOMER_SIGN_IN = new Set([
  '/api/auth/key',
  '/api/auth/invite',
  '/api/auth/signup',
  '/api/auth/login',
  '/api/auth/telegram',
  '/api/auth/telegram/start',
  '/api/auth/telegram/callback',
]);

export function keySessionMay(method: string, path: string): boolean {
  if (method === 'OPTIONS' || method === 'HEAD') return true;
  return KEY_SESSION_PATHS.some(([methods, re]) => (methods === '*' || methods.includes(method)) && re.test(path));
}

/**
 * - A web key or customer account session: only the paths above.
 * - The customer-only domains (WEB_DOMAINS): no sign-in but the key, and no
 *   session other than a key session (an admin token taken there does not work).
 */
export const sessionScope = createMiddleware<AppBindings>(async (c, next) => {
  const path = c.req.path;
  const customerSite = c.req.header(CUSTOMER_SITE_HEADER) === 'customer';
  if (customerSite && path.startsWith('/api/auth') && !CUSTOMER_SIGN_IN.has(path)) {
    throw new ApiError(403, 'customer_site', 'Only customers can sign in here');
  }
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return next();
  let claims: SessionClaims;
  try {
    claims = await authenticate(header.slice(7), c.get('env'), c.get('db'));
  } catch {
    // A bad token: the route's own check answers (401), or it is a public route.
    if (customerSite) throw ApiError.unauthorized('Invalid or expired session');
    return next();
  }
  if (!customerOnly(claims)) {
    if (customerSite) throw new ApiError(403, 'customer_site', 'Only customers can sign in here');
    return next();
  }
  if (!keySessionMay(c.req.method, path)) {
    throw ApiError.forbidden('Not available when signed in with a web key');
  }
  return next();
});
