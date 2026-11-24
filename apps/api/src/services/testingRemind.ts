import type { TestingNotJoined } from '@tma-shop/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, testingEntries, testings, users } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { botToken } from './activeBot.js';
import { withoutBlockedIn } from './blacklist.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { orderLink, testingLink } from './reminders.js';
import type { ShopRow } from './shop.js';
import { donationsOpen } from './testing.js';
import { testedLabel } from './testingDraw.js';

/**
 * The organisers remind those in a testing whose order is not paid yet: each
 * gets a message with a button to their order. Returns how many got it.
 */
export async function remindUnpaid(db: Database, env: Env, shop: ShopRow, testingId: string): Promise<{ sent: number }> {
  const testing = await db.query.testings.findFirst({
    where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)),
  });
  if (!testing) throw ApiError.notFound('Testing not found');
  const rows = await db
    .select({ order: orders })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .where(
      and(
        eq(testingEntries.testingId, testing.id),
        ne(orders.status, 'cancelled'),
        sql`${orders.amountPaid} < ${orders.total}`,
      ),
    );
  const people = rows.flatMap(({ order }) => (order.userId === null ? [] : [{ order, userId: order.userId }]));
  if (people.length === 0) return { sent: 0 };

  const telegram = new TelegramApi(botToken(env));
  const appUrl = await miniAppUrl(telegram).catch(() => null);
  const langs = await languagesOf(
    db,
    people.map((p) => p.userId),
  );
  const what = await testedLabel(db, testing);
  const allowed = new Set(await withoutBlockedIn(db, env, shop.id, people.map((p) => p.userId)));
  let sent = 0;
  for (const { order, userId } of people) {
    if (!allowed.has(userId)) continue;
    const lang = langs.get(userId) ?? 'en';
    const amount = `${((order.total - order.amountPaid) / 100).toFixed(2)} ${order.currency}`;
    const ref = tr(lang, 'order.ref', { shop: shop.name, id: order.id.slice(0, 8) });
    try {
      await telegram.sendMessage(
        userId,
        tr(lang, 'testing.remindUnpaid', { ref, amount, what }),
        appUrl
          ? { inline_keyboard: [[{ text: tr(lang, 'reminder.pay'), web_app: { url: orderLink(appUrl, shop.slug, order.id) } }]] }
          : undefined,
      );
      sent++;
    } catch (error) {
      // They blocked the bot or never started it.
      console.warn(`Could not remind order ${order.id}:`, error instanceof Error ? error.message : error);
    }
  }
  return { sent };
}

type TestingRow = typeof testings.$inferSelect;

async function findTesting(db: Database, shop: ShopRow, testingId: string): Promise<TestingRow> {
  const testing = await db.query.testings.findFirst({
    where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)),
  });
  if (!testing) throw ApiError.notFound('Testing not found');
  return testing;
}

/** Buyers of what is tested (orders not cancelled) who are not in the testing, one each. */
export async function listNotJoined(db: Database, shop: ShopRow, testingId: string): Promise<TestingNotJoined[]> {
  const testing = await findTesting(db, shop, testingId);
  const rows = await db
    .select({
      orderId: orders.id,
      userId: orders.userId,
      contact: orders.contactUsername,
      quantity: orderItems.quantity,
      name: users.firstName,
      username: users.username,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(users, eq(orders.userId, users.telegramId))
    .where(
      and(
        eq(orders.shopId, shop.id),
        ne(orders.status, 'cancelled'),
        eq(orders.external, false),
        eq(orderItems.productId, testing.productId),
        testing.variantId ? eq(orderItems.variantId, testing.variantId) : undefined,
        sql`${orders.userId} IS NOT NULL`,
        sql`NOT EXISTS (SELECT 1 FROM ${testingEntries} WHERE ${testingEntries.testingId} = ${testing.id} AND ${testingEntries.userId} = ${orders.userId})`,
      ),
    )
    .orderBy(desc(orders.createdAt));
  const people = new Map<number, TestingNotJoined>();
  for (const row of rows) {
    const userId = row.userId!;
    const seen = people.get(userId);
    if (seen) {
      seen.units += row.quantity;
      continue;
    }
    people.set(userId, {
      userId,
      // Never without a name: their id at least.
      name: row.name ?? String(userId),
      contact: row.contact ?? row.username ?? null,
      units: row.quantity,
      orderId: row.orderId,
      ref: row.orderId.slice(0, 8),
    });
  }
  return [...people.values()];
}

/**
 * The organisers invite those who bought what is tested and are not in it,
 * while one can still join: a message with a button to the Testing screen.
 */
export async function inviteNotJoined(db: Database, env: Env, shop: ShopRow, testingId: string): Promise<{ sent: number }> {
  const testing = await findTesting(db, shop, testingId);
  if (testing.status !== 'open' && !(testing.status === 'closed' && donationsOpen(testing))) {
    throw ApiError.conflict('testing_not_open', 'This testing is closed');
  }
  const people = await listNotJoined(db, shop, testingId);
  if (people.length === 0) return { sent: 0 };
  const telegram = new TelegramApi(botToken(env));
  const appUrl = await miniAppUrl(telegram).catch(() => null);
  const ids = people.map((p) => p.userId);
  const langs = await languagesOf(db, ids);
  const what = await testedLabel(db, testing);
  const allowed = new Set(await withoutBlockedIn(db, env, shop.id, ids));
  let sent = 0;
  for (const { userId } of people) {
    if (!allowed.has(userId)) continue;
    const lang = langs.get(userId) ?? 'en';
    try {
      await telegram.sendMessage(
        userId,
        tr(lang, 'testing.inviteBuyer', { shop: shop.name, what }),
        appUrl
          ? { inline_keyboard: [[{ text: tr(lang, 'testing.openButton'), web_app: { url: testingLink(appUrl, shop.slug) } }]] }
          : undefined,
      );
      sent++;
    } catch (error) {
      console.warn(`Could not invite ${userId} to a testing:`, error instanceof Error ? error.message : error);
    }
  }
  return { sent };
}
