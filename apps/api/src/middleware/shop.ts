import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../context.js';
import { verifySession } from '../auth/jwt.js';
import { ApiError } from '../lib/errors.js';
import { canManageShop, resolveShop } from '../services/shop.js';
import { isVipOf } from '../services/vip.js';
import { canOwnShop } from '../services/team.js';
import { disclaimerPending } from '../services/disclaimer.js';
import { and, eq } from 'drizzle-orm';
import { isClosedAt } from '@tma-shop/shared';
import { orders } from '../db/schema.js';

/** Telegram id of the caller when a valid session token is present, else undefined. */
export async function peekUserId(header: string | undefined, secret: string): Promise<number | undefined> {
  if (!header?.startsWith('Bearer ')) return undefined;
  try {
    const claims = await verifySession(header.slice('Bearer '.length).trim(), secret);
    return claims.sub;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the shop named by the `X-Shop` header (id or slug) and whether the
 * caller can manage it. Hidden shops behave as missing for everyone else, and
 * VIP-only shops for anyone who is not in their VIP club.
 */
export const withShop = createMiddleware<AppBindings>(async (c, next) => {
  const env = c.get('env');
  const shop = await resolveShop(c.get('db'), c.req.header('X-Shop'));
  const userId = await peekUserId(c.req.header('Authorization'), env.JWT_SECRET);
  const canManage = canManageShop(env, shop, userId);
  if (!shop.isVisible && !canManage) throw ApiError.notFound('Shop not found');
  // VIPs matter everywhere now (VIP prices, no fee), not only in VIP-only GBs.
  const isVip = userId !== undefined ? await isVipOf(c.get('db'), env, shop, userId) : false;
  if (shop.vipOnly && !canManage && !isVip) throw ApiError.notFound('Shop not found');
  // A closed GB is still open for consultation to those who ordered in it.
  if (isClosedAt(shop) && !canManage) {
    const ordered =
      userId !== undefined &&
      (await c.get('db').query.orders.findFirst({
        where: and(eq(orders.shopId, shop.id), eq(orders.userId, userId)),
        columns: { id: true },
      })) !== undefined;
    if (!ordered) throw ApiError.notFound('Shop not found');
  }

  c.set('shop', shop);
  c.set('isVip', isVip);
  c.set('shopId', shop.id);
  c.set('canManage', canManage);
  c.set('canOwn', canOwnShop(env, shop, userId));
  c.set(
    'disclaimerPending',
    !canManage && (await disclaimerPending(c.get('db'), shop, userId)),
  );
  await next();
});
