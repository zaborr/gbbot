import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { authenticate } from '../auth/middleware.js';

/** Set by Caddy (overwriting whatever the client sent) on the customer-only domains. */
export const CUSTOMER_SITE_HEADER = 'X-Gb-Site';

/**
 * On a customer-only domain: customers who entered with a web key, nothing else.
 * No sign-in but the key, and no session other than a key session (an admin
 * token taken there does not work).
 */
export const customerSiteOnly = createMiddleware<AppBindings>(async (c, next) => {
  if (c.req.header(CUSTOMER_SITE_HEADER) !== 'customer') return next();
  const path = c.req.path;
  if (path.startsWith('/api/auth') && path !== '/api/auth/key') {
    throw new ApiError(403, 'customer_site', 'Only customers can sign in here');
  }
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) {
    let ck: string | undefined;
    try {
      ck = (await authenticate(header.slice(7), c.get('env'), c.get('db'))).ck;
    } catch {
      throw ApiError.unauthorized('Invalid or expired session');
    }
    if (ck === undefined) throw new ApiError(403, 'customer_site', 'Only customers can sign in here');
  }
  return next();
});
