import { and, eq, ne, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orders, testingEntries, testings } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { botToken } from './activeBot.js';
import { withoutBlockedIn } from './blacklist.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { orderLink } from './reminders.js';
import type { ShopRow } from './shop.js';
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
