import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../context.js';
import { authenticate } from '../auth/middleware.js';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import { canManageShop, resolveShop } from '../services/shop.js';
import { isGuestOf, isVipOf } from '../services/vip.js';
import { isBlocked } from '../services/blacklist.js';
import { canOwnShop } from '../services/team.js';
import { disclaimerPending } from '../services/disclaimer.js';
import { shopsOpenToOutside } from '../services/testing.js';
import { and, eq } from 'drizzle-orm';
import { isClosedAt } from '@tma-shop/shared';
import { orders } from '../db/schema.js';
import { customerOnly, type SessionClaims } from '../auth/jwt.js';

/** The caller's session when a valid token is present, else undefined. */
async function peekClaims(header: string | undefined, env: Env, db: Database): Promise<SessionClaims | undefined> {
  if (!header?.startsWith('Bearer ')) return undefined;
  try {
    return await authenticate(header.slice('Bearer '.length).trim(), env, db);
  } catch {
    return undefined;
  }
}

/** Telegram id of the caller when a valid session token is present, else undefined. */
export async function peekUserId(
  header: string | undefined,
  env: Env,
  db: Database,
): Promise<number | undefined> {
  return (await peekClaims(header, env, db))?.sub;
}

/**
 * Resolves the shop named by the `X-Shop` header (id or slug) and whether the
 * caller can manage it. Hidden shops behave as missing for everyone else, and
 * VIP-only shops for anyone who is not in their VIP club (or, when the GB
 * lets them in, in its guest list).
 */
export const withShop = createMiddleware<AppBindings>(async (c, next) => {
  const env = c.get('env');
  const shop = await resolveShop(c.get('db'), c.req.header('X-Shop'));
  const claims = await peekClaims(c.req.header('Authorization'), env, c.get('db'));
  const userId = claims?.sub;
  // A customer's web key reaches only its GB, and never manages it.
  if (claims?.ws !== undefined && claims.ws !== shop.id) throw ApiError.notFound('Shop not found');
  const keyed = customerOnly(claims);
  const canManage = !keyed && canManageShop(env, shop, userId);
  if (!shop.isVisible && !canManage) throw ApiError.notFound('Shop not found');
  // Blacklisted: for them the GB does not exist (same answer as a missing one).
  if (userId !== undefined && (await isBlocked(c.get('db'), env, shop, userId))) {
    throw ApiError.notFound('Shop not found');
  }
  // VIPs matter everywhere now (VIP prices, no fee), not only in VIP-only GBs.
  const isVip = userId !== undefined ? await isVipOf(c.get('db'), env, shop, userId) : false;
  if (shop.vipOnly && !canManage && !isVip) {
    const guest = userId !== undefined && shop.allowGuests && (await isGuestOf(c.get('db'), env, shop, userId));
    if (!guest) throw ApiError.notFound('Shop not found');
  }
  // A closed GB is still open for consultation to those who ordered in it.
  if (isClosedAt(shop) && !canManage) {
    const ordered =
      userId !== undefined &&
      (await c.get('db').query.orders.findFirst({
        where: and(eq(orders.shopId, shop.id), eq(orders.userId, userId)),
        columns: { id: true },
      })) !== undefined;
    // Or who can still join one of its testings from outside.
    const outside = !ordered && shop.testingEnabled && (await shopsOpenToOutside(c.get('db'), [shop.id])).has(shop.id);
    if (!ordered && !outside) throw ApiError.notFound('Shop not found');
  }

  c.set('shop', shop);
  c.set('isVip', isVip);
  c.set('shopId', shop.id);
  c.set('canManage', canManage);
  c.set('canOwn', !keyed && canOwnShop(env, shop, userId));
  c.set(
    'disclaimerPending',
    !canManage && (await disclaimerPending(c.get('db'), shop, userId)),
  );
  await next();
});
