import { orderFeeFor, shipUnitsOf, shippingCost, type AdminCreateOrderRequest, type Order } from '@tma-shop/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, pendingOrders, products, shops, users } from '../db/schema.js';
import { toOrderDTO, variantLabel } from '../db/mappers.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { botToken } from './activeBot.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { buildOrderDraft, markOrderPaid, type DraftLine } from './orders.js';
import { orderLink } from './reminders.js';
import type { ShopRow } from './shop.js';
import { loadVariants, quantitiesByProduct, tieredPrice, lineStock } from './variants.js';
import { vipsAmong } from './vip.js';

export type CreateResult = { order: Order; notified: boolean; pending: false } | { order: null; notified: false; pending: true };

/** "@Ana", "ana", "t.me/ana" or "123456": how it is kept for someone not seen yet. */
function whoKey(who: string): string {
  const raw = who.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  return /^\d+$/.test(raw) ? raw : raw.toLowerCase();
}

/**
 * The organisers make an order for someone: with the usual prices (VIP when
 * they are one) or set by hand, the GB's fee and the zone's shipping. The
 * address is added by the customer from the order (only they can encrypt it).
 * Someone who has not opened the bot yet gets it when they do.
 */
export async function createOrderFor(
  db: Database,
  env: Env,
  shop: ShopRow,
  input: AdminCreateOrderRequest,
): Promise<CreateResult> {
  const key = whoKey(input.who);
  const person = await db.query.users.findFirst({
    where: /^\d+$/.test(key) ? eq(users.telegramId, Number(key)) : sql`lower(${users.username}) = ${key}`,
  });
  // Checked now, so a wrong product or zone is said at once even when it waits.
  await validate(db, shop, input);
  if (!person) {
    await db.insert(pendingOrders).values({ shopId: shop.id, who: key, request: input });
    return { order: null, notified: false, pending: true };
  }
  return make(db, env, shop, person.telegramId, input);
}

async function validate(db: Database, shop: ShopRow, input: AdminCreateOrderRequest): Promise<void> {
  const zones = shop.shippingZones.filter((z) => z.isActive);
  if (zones.length > 0 && !zones.some((z) => z.id === input.shippingZoneId)) {
    throw ApiError.badRequest('shipping_required', 'Choose a shipping zone');
  }
  const ids = [...new Set(input.items.map((i) => i.productId))];
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.shopId, shop.id), inArray(products.id, ids)));
  if (rows.length !== ids.length) throw ApiError.badRequest('bad_product', 'A product is not in this GB');
  const currencies = new Set(rows.map((p) => p.currency));
  if (currencies.size > 1) {
    throw ApiError.badRequest('mixed_currency', 'The cart mixes currencies; remove the items priced in the other token');
  }
  const variants = await loadVariants(db, ids);
  for (const item of input.items) {
    const product = rows.find((p) => p.id === item.productId)!;
    const own = variants.get(product.id) ?? [];
    if (product.options.length > 0 && !own.some((v) => v.id === item.variantId)) {
      throw ApiError.badRequest('bad_variant', 'Choose a variant of each product');
    }
    if (product.options.length === 0 && item.variantId) throw ApiError.badRequest('bad_variant', 'Choose a variant of each product');
  }
}

async function make(
  db: Database,
  env: Env,
  shop: ShopRow,
  userId: number,
  input: AdminCreateOrderRequest,
): Promise<CreateResult> {
  const isVip = (await vipsAmong(db, env, shop, [userId])).has(userId);
  const ids = [...new Set(input.items.map((i) => i.productId))];
  const rows = await db.select().from(products).where(and(eq(products.shopId, shop.id), inArray(products.id, ids)));
  const variants = await loadVariants(db, ids);
  const qty = quantitiesByProduct(input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
  const lines = input.items.map((item) => {
    const product = rows.find((p) => p.id === item.productId)!;
    const variant = item.variantId ? (variants.get(product.id)?.find((v) => v.id === item.variantId) ?? null) : null;
    return { item, product, variant };
  });
  const draftLines: DraftLine[] = lines.map(({ item, product, variant }) => ({
    productId: product.id,
    variantId: variant?.id ?? null,
    variantLabel: variant ? variantLabel(variant.optionValues) : null,
    title: product.title,
    titleEn: product.titleEn,
    unitPrice: item.unitPrice ?? tieredPrice(product, variant, qty.get(product.id) ?? item.quantity, isVip),
    quantity: item.quantity,
    stock: lineStock(product, variant),
  }));
  const draft = buildOrderDraft(draftLines);
  const zone = shop.shippingZones.find((z) => z.isActive && z.id === input.shippingZoneId);
  const units = lines.reduce((sum, { item, product, variant }) => sum + item.quantity * shipUnitsOf(product, variant), 0);
  const shipping = zone ? shippingCost(zone, draft.total, isVip && shop.vipNoShipping, units) : 0;
  const fee = orderFeeFor(shop, isVip);
  const person = await db.query.users.findFirst({ where: eq(users.telegramId, userId) });
  const [order] = await db
    .insert(orders)
    .values({
      shopId: shop.id,
      userId,
      status: 'pending',
      isVip,
      total: draft.total + fee + shipping,
      fee,
      shipping,
      shippingZoneName: zone?.name ?? null,
      currency: rows[0]?.currency ?? shop.currency,
      contactUsername: person?.username ?? null,
    })
    .returning();
  if (!order) throw new Error('Failed to create order');
  await db.insert(orderItems).values(draft.items.map((item) => ({ orderId: order.id, ...item })));
  let dto = input.paid
    ? await markOrderPaid(db, order.id, 'manual')
    : toOrderDTO(
        order,
        draft.items.map((item) => ({ ...item, id: '', orderId: order.id, donationUnpaid: 0, testing: false })),
      );

  let notified = false;
  if (input.notify) {
    try {
      const telegram = new TelegramApi(botToken(env));
      const appUrl = await miniAppUrl(telegram).catch(() => null);
      const lang = (await languagesOf(db, [userId])).get(userId) ?? 'en';
      const text = tr(lang, zone ? 'order.createdForYouShip' : input.paid ? 'order.createdForYouPaid' : 'order.createdForYou', {
        shop: shop.name,
        ref: order.id.slice(0, 8),
      });
      await telegram.sendMessage(
        userId,
        text,
        appUrl
          ? { inline_keyboard: [[{ text: tr(lang, 'order.viewButton'), web_app: { url: orderLink(appUrl, shop.slug, order.id) } }]] }
          : undefined,
      );
      notified = true;
    } catch (error) {
      console.warn('Could not tell about an order made for them:', error instanceof Error ? error.message : error);
    }
  }
  dto = { ...dto };
  return { order: dto, notified, pending: false };
}

/** Pending orders for someone not seen yet (the organisers' list), and taking one back. */
export async function listPendingOrders(db: Database, shopId: string) {
  return db
    .select({ id: pendingOrders.id, who: pendingOrders.who, createdAt: pendingOrders.createdAt, request: pendingOrders.request })
    .from(pendingOrders)
    .where(eq(pendingOrders.shopId, shopId));
}

export async function removePendingOrder(db: Database, shopId: string, id: string): Promise<void> {
  await db.delete(pendingOrders).where(and(eq(pendingOrders.shopId, shopId), eq(pendingOrders.id, id)));
}

/** They opened the app: the orders made for them before that are made now (best effort). */
export async function claimPendingOrders(db: Database, env: Env, userId: number, username: string | null): Promise<void> {
  const keys = [String(userId), ...(username ? [username.toLowerCase()] : [])];
  const waiting = await db.delete(pendingOrders).where(inArray(pendingOrders.who, keys)).returning();
  for (const p of waiting) {
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, p.shopId) });
    if (!shop) continue;
    try {
      await validate(db, shop, p.request);
      await make(db, env, shop, userId, p.request);
    } catch (error) {
      console.error('Could not make an order kept for someone:', error);
    }
  }
}
