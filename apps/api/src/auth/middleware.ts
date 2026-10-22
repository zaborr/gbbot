import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { verifySession, type SessionClaims } from './jwt.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { isWebSession, webSessionValid } from '../services/webAdmins.js';
import { isSuperAdmin } from '../services/shop.js';

/**
 * Checks a session token: signature and expiry, and for web admins that the
 * account still exists and was not reset since. Throws when it is not good.
 */
export async function authenticate(token: string, env: Env, db: Database): Promise<SessionClaims> {
  const claims = await verifySession(token, env.JWT_SECRET);
  if (isWebSession(claims.sub) && !(await webSessionValid(db, claims.sub, claims.ver))) {
    throw new Error('Web session revoked');
  }
  return claims;
}

/**
 * Requires a valid `Authorization: Bearer <jwt>` header and exposes the decoded
 * claims as `c.get('claims')`. Throws `ApiError(401)` otherwise.
 */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing bearer token');
  }
  const token = header.slice('Bearer '.length).trim();
  const env = c.get('env');
  try {
    const claims = await authenticate(token, env, c.get('db'));
    c.set('claims', claims);
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }
  await next();
});

/** Requires the caller to manage the current shop (run after `withShop` and `requireAuth`). */
export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.get('canManage')) {
    throw ApiError.forbidden('Shop admin role required');
  }
  await next();
});

/** Requires a platform super-admin (ADMIN_TELEGRAM_IDS). Run after `requireAuth`. */
export const requireSuperAdmin = createMiddleware<AppBindings>(async (c, next) => {
  if (!isSuperAdmin(c.get('env'), c.get('claims').sub)) {
    throw ApiError.forbidden('Platform admin role required');
  }
  await next();
});

/** Requires the GB's disclaimer to be accepted (run after `withShop`). */
export const requireDisclaimer = createMiddleware<AppBindings>(async (c, next) => {
  if (c.get('disclaimerPending')) {
    throw new ApiError(403, 'disclaimer_required', 'Accept the GB conditions first');
  }
  await next();
});

/** Requires administrator powers over the current shop (run after `withShop` and `requireAuth`). */
export const requireOwner = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.get('canOwn')) {
    throw ApiError.forbidden("Only the GB's administrators can do this");
  }
  await next();
});

/**
 * Customer actions (cart, orders, own settings) need a Telegram account: web
 * administrators only manage. Run after `requireAuth`.
 */
export const requireTelegramUser = createMiddleware<AppBindings>(async (c, next) => {
  if (isWebSession(c.get('claims').sub)) {
    throw ApiError.forbidden('Only available in Telegram');
  }
  await next();
});
