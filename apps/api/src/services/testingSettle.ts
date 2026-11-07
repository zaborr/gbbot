import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { settleMoney, tierProgress, type Lang, type TestingTier } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orders, testingEntries, testings } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { languagesOf, notifyUsers } from './notifications.js';
import type { ShopRow } from './shop.js';
import { audience, testedLabel } from './testingDraw.js';

/**
 * The end of a testing: working out the money (what each participant gets
 * back), cancelling it, and sending the lab report to the participants.
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

export interface SettleInput {
  /** What the lab finally charged, per tier done (planned cost when left out). */
  realCosts: Record<string, number>;
  /** A tier added with the leftover (only when it covers it all). */
  extra?: { name: string; cost: number } | undefined;
}

/** What settling would give now (also shown before confirming). */
export async function settlePreview(db: Database, testing: TestingRow, input: SettleInput) {
  const rows = await liveEntries(db, testing.id);
  const paid = rows.filter(({ order }) => order.amountPaid >= order.total);
  const raised = paid.reduce((sum, { entry }) => sum + entry.amount, 0);
  const donorRefs = new Set(testing.draw?.donors ?? []);
  const entries = paid.map(({ entry, order }) => ({
    orderId: order.id,
    amount: entry.amount,
    donor: donorRefs.has(order.id.slice(0, 8)),
  }));
  const doneIds = new Set(testing.status === 'drawn' ? (testing.draw?.tiersDone ?? []) : []);
  const done = testing.tiers.filter((tier) => doneIds.has(tier.id));
  // No tier done (not even the first reached, or none could be covered): everything goes back.
  const allBack =
    testing.status === 'drawn'
      ? done.length === 0
      : !(tierProgress(testing.tiers, raised, testing.contribution)[0]?.reached ?? false);
  const cost = (tier: TestingTier): number => input.realCosts[tier.id] ?? tier.realCost ?? tier.cost;
  const base = done.reduce((sum, tier) => sum + cost(tier), 0);
  const before = settleMoney(entries, base, testing.refundThreshold, allBack);
  if (input.extra && input.extra.cost > before.settlement.leftover) {
    throw ApiError.conflict('extra_not_covered', 'The leftover does not cover that extra tier');
  }
  const spent = base + (input.extra?.cost ?? 0);
  return { ...settleMoney(entries, spent, testing.refundThreshold, allBack), done, cost, paid };
}

/** Settles the money of a drawn testing (or one that reached no tier): refunds go on the orders. */
export async function settleTesting(
  db: Database,
  env: Env,
  shop: ShopRow,
  id: string,
  input: SettleInput,
): Promise<TestingRow> {
  const testing = await findTesting(db, shop.id, id);
  if (testing.status !== 'drawn' && testing.status !== 'closed') {
    throw ApiError.conflict('settle_not_ready', 'Draw the donors before settling');
  }
  const { settlement, refunds, done, cost, paid } = await settlePreview(db, testing, input);
  if (testing.status === 'closed' && !settlement.allBack) {
    throw ApiError.conflict('settle_not_ready', 'Draw the donors before settling');
  }
  const tiers: TestingTier[] = testing.tiers.map((tier) =>
    done.includes(tier) ? { ...tier, realCost: cost(tier) } : tier,
  );
  if (input.extra) {
    tiers.push({
      id: `extra-${Date.now().toString(36)}`,
      name: input.extra.name,
      cost: input.extra.cost,
      realCost: input.extra.cost,
      vials: 0,
      extra: true,
    });
  }
  const [row] = await db.transaction(async (tx) => {
    for (const { entry, order } of paid) await refundEntry(tx, entry, refunds.get(order.id) ?? 0);
    return tx
      .update(testings)
      .set({
        status: 'settled',
        tiers,
        settlement: { ...settlement, at: new Date().toISOString() },
        draw: testing.draw && input.extra
          ? { ...testing.draw, tiersDone: [...testing.draw.tiersDone, tiers[tiers.length - 1]?.id ?? ''] }
          : testing.draw,
        updatedAt: new Date(),
      })
      .where(and(eq(testings.id, testing.id), inArray(testings.status, ['drawn', 'closed'])))
      .returning();
  });
  if (!row) throw ApiError.conflict('settle_not_ready', 'Draw the donors before settling');

  const what = await testedLabel(db, testing);
  for (const { order } of paid) {
    if (order.userId === null) continue;
    const back = refunds.get(order.id) ?? 0;
    const [chat] = await audience(db, env, shop, [order.id]);
    if (chat === undefined) continue;
    await notifyUsers(db, env.BOT_TOKEN, [chat], (lang: Lang) =>
      back > 0
        ? tr(lang, 'testing.settledRefund', {
            shop: shop.name,
            product: what,
            amount: formatMoney(back, testing.currency),
          })
        : tr(lang, 'testing.settledNoRefund', { shop: shop.name, product: what }),
    );
  }
  return row;
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
  await notifyUsers(db, env.BOT_TOKEN, ids, (lang) => tr(lang, 'testing.cancelled', { shop: shop.name, product: what }));
  return row;
}

/** Who gets the report: participants who paid, and the donors. */
async function reportAudience(db: Database, env: Env, shop: ShopRow, testing: TestingRow): Promise<number[]> {
  const rows = await liveEntries(db, testing.id);
  const donorOrders = (testing.draw?.candidates ?? [])
    .filter((c) => testing.draw?.donors.includes(c.ref))
    .map((c) => c.orderId);
  const paid = rows.filter(({ order }) => order.amountPaid >= order.total).map(({ order }) => order.id);
  return audience(db, env, shop, [...new Set([...paid, ...donorOrders])]);
}

/** The bot asks this organiser (in their chat with it) to reply with the report. */
export async function requestReport(
  db: Database,
  env: Env,
  shop: ShopRow,
  id: string,
  organiserId: number,
  lang: Lang,
  telegram = new TelegramApi(env.BOT_TOKEN),
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
