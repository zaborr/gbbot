import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Lang } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, testingEntries, testings } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { languagesOf, notifyUsers } from './notifications.js';
import type { ShopRow } from './shop.js';
import { audience, testedLabel } from './testingDraw.js';
import { botToken } from './activeBot.js';
import { reachedTiers } from './testing.js';
import { refundDonations } from './testingDonations.js';

/**
 * The end of a testing: closing it (donors get their vial's price back),
 * cancelling it, and sending the lab report to whoever may see it.
 * Refunds are made the usual way: an order that now costs less than what was
 * paid shows what is owed, and the organiser marks it as sent back.
 */

type TestingRow = typeof testings.$inferSelect;

/** "12.50 USDC", as the bot writes amounts. */
function formatMoney(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

async function findTesting(db: Database, shopId: string, id: string): Promise<TestingRow> {
  const row = await db.query.testings.findFirst({ where: and(eq(testings.shopId, shopId), eq(testings.id, id)) });
  if (!row) throw ApiError.notFound('Testing not found');
  return row;
}

/** Entries on orders not cancelled, with whether each order is paid in full. */
async function liveEntries(db: Pick<Database, 'select'>, testingId: string) {
  return db
    .select({ entry: testingEntries, order: orders })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .where(and(eq(testingEntries.testingId, testingId), ne(orders.status, 'cancelled')))
    .orderBy(asc(testingEntries.createdAt));
}

/** Takes `refund` off an entry and its order (which then owes it back to the customer). */
async function refundEntry(
  tx: Pick<Database, 'update'>,
  entry: typeof testingEntries.$inferSelect,
  refund: number,
): Promise<void> {
  if (refund <= 0) return;
  await tx
    .update(testingEntries)
    .set({ amount: entry.amount - refund })
    .where(eq(testingEntries.id, entry.id));
  await tx
    .update(orders)
    .set({
      testing: sql`${orders.testing} - ${refund}`,
      total: sql`${orders.total} - ${refund}`,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, entry.orderId));
}

/**
 * Closes a drawn testing (or one that reached no tier): each donor gets the
 * price of the vial they give back on their order (shown there as owed, then
 * marked as sent back the usual way). The fees stay: nothing else goes back.
 */
export async function settleTesting(db: Database, env: Env, shop: ShopRow, id: string): Promise<TestingRow> {
  const testing = await findTesting(db, shop.id, id);
  const nothingReached = testing.status === 'closed' && !(await anyTierReached(db, testing));
  if (testing.status !== 'drawn' && !nothingReached) {
    throw ApiError.conflict('settle_not_ready', 'Draw the donors before settling');
  }
  const draw = testing.draw;
  const donors = (draw?.candidates ?? []).filter((c) => draw?.donors.includes(c.ref));
  const rows = await liveEntries(db, testing.id);
  const [row] = await db.transaction(async (tx) => {
    for (const donor of donors) {
      const found = rows.find(({ order }) => order.id === donor.orderId);
      if (found) await refundEntry(tx, found.entry, donor.vialPrice);
    }
    return tx
      .update(testings)
      .set({ status: 'settled', updatedAt: new Date() })
      .where(and(eq(testings.id, testing.id), inArray(testings.status, ['drawn', 'closed'])))
      .returning();
  });
  if (!row) throw ApiError.conflict('settle_not_ready', 'Draw the donors before settling');

  const what = await testedLabel(db, testing);
  for (const donor of donors) {
    const [chat] = await audience(db, env, shop, [donor.orderId]);
    if (chat === undefined || donor.vialPrice <= 0) continue;
    await notifyUsers(db, botToken(env), [chat], (lang: Lang) =>
      tr(lang, 'testing.vialRefund', {
        shop: shop.name,
        product: what,
        amount: formatMoney(donor.vialPrice, testing.currency),
      }),
    );
  }
  return row;
}

/** Whether the pot covers at least the first tier. */
async function anyTierReached(db: Database, testing: TestingRow): Promise<boolean> {
  return (await reachedTiers(db, testing)).length > 0;
}

/**
 * Cancels a testing (the lab cannot do it, for instance): everything paid
 * goes back, unpaid contributions leave their orders, donor marks are removed.
 */
export async function cancelTesting(db: Database, env: Env, shop: ShopRow, id: string): Promise<TestingRow> {
  const testing = await findTesting(db, shop.id, id);
  if (testing.status === 'settled' || testing.status === 'cancelled') {
    throw ApiError.conflict('testing_finished', 'This testing is already finished');
  }
  const rows = await liveEntries(db, testing.id);
  const what = await testedLabel(db, testing);
  const donorOrders = (testing.draw?.candidates ?? [])
    .filter((c) => testing.draw?.donors.includes(c.ref))
    .map((c) => c.orderId);
  const [row] = await db.transaction(async (tx) => {
    for (const { entry, order } of rows) {
      if (order.amountPaid >= order.total) {
        await refundEntry(tx, entry, entry.amount);
      } else {
        // Not paid: it simply leaves the order.
        await tx.delete(testingEntries).where(eq(testingEntries.id, entry.id));
        await tx
          .update(orders)
          .set({
            testing: sql`${orders.testing} - ${entry.amount}`,
            total: sql`${orders.total} - ${entry.amount}`,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, order.id));
      }
    }
    if (donorOrders.length > 0) {
      await tx
        .update(orders)
        .set({ donatedVials: sql`${orders.donatedVials} - ${what}::text` })
        .where(inArray(orders.id, donorOrders));
    }
    // What was given goes back too.
    await refundDonations(tx, testing);
    return tx
      .update(testings)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(testings.id, testing.id))
      .returning();
  });
  if (!row) throw ApiError.notFound('Testing not found');
  const ids = await audience(
    db,
    env,
    shop,
    rows.map((r) => r.order.id),
  );
  await notifyUsers(db, botToken(env), ids, (lang) => tr(lang, 'testing.cancelled', { shop: shop.name, product: what }));
  return row;
}

/**
 * Who gets the report: those who paid the fee, the donors, and VIPs exempt
 * from the fee who bought what is tested (they see every result).
 */
async function reportAudience(db: Database, env: Env, shop: ShopRow, testing: TestingRow): Promise<number[]> {
  const rows = await liveEntries(db, testing.id);
  const donorOrders = (testing.draw?.candidates ?? [])
    .filter((c) => testing.draw?.donors.includes(c.ref))
    .map((c) => c.orderId);
  const paid = rows
    .filter(({ entry, order }) => entry.amount > 0 && order.amountPaid >= order.total)
    .map(({ order }) => order.id);
  const vips =
    testing.feeMode === 'mandatory_non_vip'
      ? await db
          .selectDistinct({ id: orders.id })
          .from(orders)
          .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
          .where(
            and(
              eq(orders.shopId, shop.id),
              eq(orders.isVip, true),
              ne(orders.status, 'cancelled'),
              eq(orderItems.productId, testing.productId),
              testing.variantId ? eq(orderItems.variantId, testing.variantId) : undefined,
            ),
          )
      : [];
  return audience(db, env, shop, [...new Set([...paid, ...donorOrders, ...vips.map((v) => v.id)])]);
}

/** The bot asks this organiser (in their chat with it) to reply with the report. */
export async function requestReport(
  db: Database,
  env: Env,
  shop: ShopRow,
  id: string,
  organiserId: number,
  lang: Lang,
  telegram = new TelegramApi(botToken(env)),
): Promise<void> {
  const testing = await findTesting(db, shop.id, id);
  if (testing.status !== 'drawn' && testing.status !== 'settled') {
    throw ApiError.conflict('report_not_ready', 'Send the report once the donors are drawn');
  }
  if (organiserId <= 0) throw ApiError.conflict('report_telegram', 'Open the app from Telegram to send the report');
  const what = await testedLabel(db, testing);
  const sent = (await telegram.sendMessage(
    organiserId,
    tr(lang, 'testing.reportAsk', { shop: shop.name, product: what, lab: testing.lab }),
  )) as { message_id?: number };
  if (typeof sent.message_id !== 'number') throw new Error('No message id');
  await db
    .update(testings)
    .set({ reportRequest: { chatId: organiserId, messageId: sent.message_id }, updatedAt: new Date() })
    .where(eq(testings.id, testing.id));
}

/**
 * A file sent to the bot in reply to its request: it is kept as the report
 * (only its Telegram id) and sent to the participants and donors. Returns
 * false when the message is not such a reply.
 */
export async function handleReportReply(
  db: Database,
  env: Env,
  telegram: TelegramApi,
  message: {
    chat?: { id: number };
    reply_to_message?: { message_id?: number };
    document?: { file_id: string };
    photo?: Array<{ file_id: string }>;
  },
  lang: Lang,
): Promise<boolean> {
  const chatId = message.chat?.id;
  const replyTo = message.reply_to_message?.message_id;
  const file = message.document
    ? { fileId: message.document.file_id, kind: 'document' as const }
    : message.photo && message.photo.length > 0
      ? { fileId: message.photo[message.photo.length - 1]?.file_id ?? '', kind: 'photo' as const }
      : null;
  if (chatId === undefined || replyTo === undefined || !file?.fileId) return false;
  const testing = await db.query.testings.findFirst({
    where: and(
      sql`${testings.reportRequest}->>'chatId' = ${String(chatId)}`,
      sql`${testings.reportRequest}->>'messageId' = ${String(replyTo)}`,
    ),
  });
  if (!testing) return false;
  const shop = await db.query.shops.findFirst({ where: (s, { eq: same }) => same(s.id, testing.shopId) });
  if (!shop) return false;

  const what = await testedLabel(db, testing);
  const ids = await reportAudience(db, env, shop, testing);
  const langs = await languagesOf(db, ids);
  let delivered = 0;
  for (const id of ids) {
    const caption = tr(langs.get(id) ?? 'en', 'testing.reportCaption', {
      shop: shop.name,
      product: what,
      lab: testing.lab,
    });
    try {
      await telegram.sendFileById(id, file.kind, file.fileId, caption);
      delivered += 1;
    } catch (error) {
      console.error('Report not delivered:', error);
    }
  }
  await db
    .update(testings)
    .set({ report: { ...file, sentAt: new Date().toISOString() }, reportRequest: null, updatedAt: new Date() })
    .where(eq(testings.id, testing.id));
  await telegram.sendMessage(chatId, tr(lang, 'testing.reportSent', { count: delivered }));
  return true;
}
