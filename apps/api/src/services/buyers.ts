import { and, eq, inArray } from 'drizzle-orm';
import { goodsStatus, type BuyerDetail, type BuyerProduct, type BuyerSummary, type BuyerTesting, type Order } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { cartItems, carts, productVariants, products, testingEntries, testings } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi, type InlineKeyboard } from '../telegram/api.js';
import { botToken } from './activeBot.js';
import { blockedAmong } from './blacklist.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { listAllOrders } from './orders.js';
import { shopLink } from './reminders.js';
import type { ShopRow } from './shop.js';
import { loadPeople } from './team.js';
import { listTestings } from './testing.js';
import { vipsAmong } from './vip.js';

/** Where an order's units are: not paid yet, paid to send, or sent. */
function placeOf(order: Order): keyof Pick<BuyerProduct, 'unpaid' | 'paid' | 'shipped'> | null {
  const status = goodsStatus(order);
  if (status === 'cancelled') return null;
  if (status === 'shipped' || status === 'fulfilled') return 'shipped';
  if (status === 'paid') return 'paid';
  return 'unpaid';
}

/** Units in each buyer's cart in the GB. */
async function cartUnitsBy(db: Database, shopId: string): Promise<Map<number, number>> {
  const rows = await db
    .select({ userId: carts.userId, quantity: cartItems.quantity })
    .from(cartItems)
    .innerJoin(carts, eq(cartItems.cartId, carts.id))
    .where(eq(carts.shopId, shopId));
  const result = new Map<number, number>();
  for (const row of rows) result.set(row.userId, (result.get(row.userId) ?? 0) + row.quantity);
  return result;
}

function summarize(
  userId: number,
  mine: Order[],
  info: { username: string | null; firstName: string } | undefined,
  cartUnits: number,
  blocked: boolean,
  inTesting: boolean,
  vip: boolean,
): BuyerSummary {
  const lines = new Map<string, BuyerProduct>();
  let units = 0;
  for (const order of mine) {
    const place = placeOf(order);
    if (!place) continue;
    for (const item of order.items) {
      const key = item.variantId ? `${item.productId}:${item.variantId}` : item.productId;
      const line = lines.get(key) ?? {
        key,
        title: item.title,
        variantLabel: item.variantLabel,
        unpaid: 0,
        paid: 0,
        shipped: 0,
      };
      line[place] += item.quantity;
      units += item.quantity;
      lines.set(key, line);
    }
  }
  const live = mine.filter((o) => o.status !== 'cancelled');
  return {
    telegramId: userId,
    name: info?.firstName ?? String(userId),
    username: info?.username ?? mine.find((o) => o.contactUsername)?.contactUsername ?? null,
    orders: live.length,
    units,
    currency: mine[0]?.currency ?? 'USDC',
    paid: live.reduce((sum, o) => sum + o.amountPaid, 0),
    // What they still have to pay (a refund owed to them is not a negative debt).
    owed: live.reduce((sum, o) => sum + Math.max(o.amountDue, 0), 0),
    // Products not paid yet (a donation owed on paid ones only shows in what they owe).
    unpaid: live.some((o) => placeOf(o) === 'unpaid'),
    toShip: live.some((o) => goodsStatus(o) === 'paid' && !o.external),
    testing: inTesting,
    cartUnits,
    vip,
    blocked,
    products: [...lines.values()].sort((a, b) => a.title.localeCompare(b.title)),
  };
}

/** Users with a testing entry in the GB. */
async function inTestings(db: Database, shopId: string): Promise<Set<number>> {
  const rows = await db
    .selectDistinct({ userId: testingEntries.userId })
    .from(testingEntries)
    .innerJoin(testings, eq(testingEntries.testingId, testings.id))
    .where(eq(testings.shopId, shopId));
  return new Set(rows.flatMap((r) => (r.userId === null ? [] : [r.userId])));
}

/** Everyone with an order or a cart in the GB, with what they have. Most units first. */
export async function listBuyers(db: Database, env: Env, shop: ShopRow): Promise<BuyerSummary[]> {
  const [all, carted, tested] = await Promise.all([
    listAllOrders(db, shop.id),
    cartUnitsBy(db, shop.id),
    inTestings(db, shop.id),
  ]);
  const byUser = new Map<number, Order[]>();
  for (const order of all) {
    if (order.userId === null) continue;
    byUser.set(order.userId, [...(byUser.get(order.userId) ?? []), order]);
  }
  for (const userId of carted.keys()) if (!byUser.has(userId)) byUser.set(userId, []);
  const ids = [...byUser.keys()];
  const [people, blocked, vips] = await Promise.all([
    loadPeople(db, ids),
    blockedAmong(db, env, shop, ids),
    vipsAmong(db, env, shop, ids),
  ]);
  return ids
    .map((id) =>
      summarize(
        id,
        byUser.get(id) ?? [],
        people.get(id),
        carted.get(id) ?? 0,
        blocked.has(id),
        tested.has(id),
        vips.has(id),
      ),
    )
    .sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
}

/** One buyer in full: products, cart, orders and testings. */
export async function getBuyer(db: Database, env: Env, shop: ShopRow, userId: number): Promise<BuyerDetail> {
  const mine = (await listAllOrders(db, shop.id)).filter((o) => o.userId === userId);
  const cartRows = await db
    .select({
      title: products.title,
      options: productVariants.optionValues,
      quantity: cartItems.quantity,
    })
    .from(cartItems)
    .innerJoin(carts, eq(cartItems.cartId, carts.id))
    .innerJoin(products, eq(cartItems.productId, products.id))
    .leftJoin(productVariants, eq(cartItems.variantId, productVariants.id))
    .where(and(eq(carts.shopId, shop.id), eq(carts.userId, userId)));
  if (mine.length === 0 && cartRows.length === 0) throw ApiError.notFound('Buyer not found');

  const entries = mine.length
    ? await db
        .select({ testingId: testingEntries.testingId, orderId: testingEntries.orderId, volunteer: testingEntries.volunteer })
        .from(testingEntries)
        .where(
          inArray(
            testingEntries.orderId,
            mine.map((o) => o.id),
          ),
        )
    : [];
  const views = entries.length ? await listTestings(db, shop.id) : [];
  const byId = new Map(views.map((x) => [x.id, x]));
  const orderById = new Map(mine.map((o) => [o.id, o]));
  const testingList: BuyerTesting[] = entries.flatMap((entry) => {
    const view = byId.get(entry.testingId);
    if (!view) return [];
    const order = orderById.get(entry.orderId);
    return [
      {
        id: view.id,
        label: view.variantLabel ? `${view.productTitle} · ${view.variantLabel}` : view.productTitle,
        volunteer: entry.volunteer,
        donor: (view.draw?.donors ?? []).includes(entry.orderId.slice(0, 8)),
        paid: order ? order.amountDue === 0 : false,
      },
    ];
  });

  const [people, blocked, vips] = await Promise.all([
    loadPeople(db, [userId]),
    blockedAmong(db, env, shop, [userId]),
    vipsAmong(db, env, shop, [userId]),
  ]);
  const cartUnits = cartRows.reduce((sum, row) => sum + row.quantity, 0);
  return {
    ...summarize(userId, mine, people.get(userId), cartUnits, blocked.has(userId), testingList.length > 0, vips.has(userId)),
    cart: cartRows.map((row) => ({
      title: row.title,
      variantLabel: row.options ? row.options.join(' / ') : null,
      quantity: row.quantity,
    })),
    orderList: mine,
    testings: testingList,
  };
}

/** Whether the bot can write to them (a moment of "typing…"; Telegram refuses otherwise). */
export async function buyerReachable(env: Env, userId: number, telegram = new TelegramApi(botToken(env))): Promise<boolean> {
  try {
    await telegram.sendChatAction(userId);
    return true;
  } catch {
    return false;
  }
}

/** A message from the GB to one buyer, through the bot, with a button to the GB. */
export async function messageBuyer(
  db: Database,
  env: Env,
  shop: ShopRow,
  userId: number,
  text: string,
  telegram = new TelegramApi(botToken(env)),
): Promise<{ sent: boolean }> {
  const lang = (await languagesOf(db, [userId])).get(userId) ?? 'en';
  const appUrl = await miniAppUrl(telegram).catch(() => null);
  const keyboard: InlineKeyboard | undefined = appUrl
    ? { inline_keyboard: [[{ text: tr(lang, 'broadcast.button'), web_app: { url: shopLink(appUrl, shop.slug) } }]] }
    : undefined;
  try {
    await telegram.sendMessage(userId, `${tr(lang, 'broadcast.header', { shop: shop.name })}\n\n${text}`, keyboard);
    return { sent: true };
  } catch {
    return { sent: false };
  }
}
