import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, testingEntries, testings, users } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { botToken, botUsername } from './activeBot.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { orderLink } from './reminders.js';
import type { ShopRow } from './shop.js';
import { joinedBy } from './testing.js';
import { testedLabel } from './testingDraw.js';

export interface AddParticipantInput {
  /** @username or Telegram id. */
  who: string;
  /** What they pay; null = the testing's fee. 0 = nothing. */
  amount: number | null;
  volunteer: boolean;
  /** Tell them through the bot (with a button to their order). */
  notify: boolean;
}

/**
 * The organisers put someone in a testing by hand: a buyer of the tested
 * product joins from that order; anyone else gets an order of only the fee
 * (from outside), whether or not the testing takes people from outside. Until
 * the draw is launched, whatever the times.
 */
export async function addParticipant(
  db: Database,
  env: Env,
  shop: ShopRow,
  testingId: string,
  input: AddParticipantInput,
): Promise<{ orderId: string; notified: boolean }> {
  const who = input.who.trim().replace(/^@/, '');
  const person = /^\d+$/.test(who)
    ? await db.query.users.findFirst({ where: eq(users.telegramId, Number(who)) })
    : await db.query.users.findFirst({ where: sql`lower(${users.username}) = ${who.toLowerCase()}` });
  if (!person) {
    const bot = botUsername();
    throw new ApiError(
      404,
      'testing_not_seen',
      bot ? `This person has not opened the bot yet: send them https://t.me/${bot}` : 'This person has not opened the bot yet',
    );
  }
  const userId = person.telegramId;

  const { orderId, amount } = await db.transaction(async (tx) => {
    const testing = await tx.query.testings.findFirst({
      where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)),
    });
    if (!testing) throw ApiError.notFound('Testing not found');
    if (testing.status !== 'open' && testing.status !== 'closed') {
      throw ApiError.conflict('testing_not_open', 'This testing is closed');
    }
    if ((await joinedBy(tx, userId, [testing.id])).size > 0) {
      throw ApiError.conflict('testing_joined_other', 'This person already takes part in this testing');
    }
    const amount = input.amount ?? testing.contribution;

    // Bought the tested product here: they join from that order.
    const [bought] = await tx
      .select({ order: orders })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.shopId, shop.id),
          eq(orders.userId, userId),
          ne(orders.status, 'cancelled'),
          eq(orders.external, false),
          eq(orderItems.productId, testing.productId),
          testing.variantId ? eq(orderItems.variantId, testing.variantId) : undefined,
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(1);
    if (bought) {
      const order = bought.order;
      // A payment being checked would no longer match its amount.
      if (order.status === 'awaiting_payment') {
        throw ApiError.conflict('testing_order_state', 'A testing cannot be added to this order now');
      }
      if (order.currency !== testing.currency) {
        throw ApiError.conflict('mixed_currency', `This order is in ${order.currency}`);
      }
      await tx
        .insert(testingEntries)
        .values({ testingId: testing.id, orderId: order.id, userId, amount, volunteer: input.volunteer });
      if (amount > 0) {
        const sent = order.status === 'shipped' || order.status === 'fulfilled';
        await tx
          .update(orders)
          .set({
            testing: order.testing + amount,
            total: order.total + amount,
            status: 'pending',
            resumeStatus: sent ? order.status : order.resumeStatus,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, order.id));
      }
      return { orderId: order.id, amount };
    }

    // Anyone else: an order of only the fee, with nothing to send.
    const [order] = await tx
      .insert(orders)
      .values({
        shopId: shop.id,
        userId,
        external: true,
        externalTestingId: testing.id,
        status: amount > 0 ? 'pending' : 'paid',
        total: amount,
        testing: amount,
        currency: testing.currency,
        contactUsername: person.username,
      })
      .returning({ id: orders.id });
    if (!order) throw new Error('Failed to create the order');
    await tx
      .insert(testingEntries)
      .values({ testingId: testing.id, orderId: order.id, userId, amount, volunteer: input.volunteer });
    return { orderId: order.id, amount };
  });

  if (!input.notify) return { orderId, notified: false };
  try {
    const telegram = new TelegramApi(botToken(env));
    const lang = (await languagesOf(db, [userId])).get(userId) ?? 'en';
    const testing = await db.query.testings.findFirst({ where: eq(testings.id, testingId) });
    const what = testing ? await testedLabel(db, testing) : '';
    const appUrl = await miniAppUrl(telegram).catch(() => null);
    await telegram.sendMessage(
      userId,
      tr(lang, amount > 0 ? 'testing.addedByOrganiser' : 'testing.addedByOrganiserFree', { shop: shop.name, what }),
      appUrl
        ? { inline_keyboard: [[{ text: tr(lang, 'testing.addedOpen'), web_app: { url: orderLink(appUrl, shop.slug, orderId) } }]] }
        : undefined,
    );
    return { orderId, notified: true };
  } catch {
    // They blocked the bot: they are in anyway.
    return { orderId, notified: false };
  }
}
