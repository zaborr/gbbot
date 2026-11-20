import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Lang, LabProgressRequest } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, testingEntries, testings } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { languagesOf } from './notifications.js';
import type { ShopRow } from './shop.js';
import { notifyTesting, audience, testedLabel, vialLabel } from './testingDraw.js';
import { botToken } from './activeBot.js';
import { takesPart, reachedTiers } from './testing.js';
import { saveReport } from './testingReports.js';
import { refundDonations } from './testingDonations.js';
import { cancelExtra, extraPayers } from './testingExtra.js';

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
  // Vials each donor gives (more than one only when the ranking went round again).
  const vialsOf = (ref: string): number => (draw?.donors ?? []).filter((r) => r === ref).length;
  const rows = await liveEntries(db, testing.id);
  const [row] = await db.transaction(async (tx) => {
    for (const donor of donors) {
      const found = rows.find(({ order }) => order.id === donor.orderId);
      if (found) await refundEntry(tx, found.entry, donor.vialPrice * vialsOf(donor.ref));
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
    await notifyTesting(db, env, shop, [chat], (lang: Lang) =>
      tr(lang, 'testing.vialRefund', {
        shop: shop.name,
        product: what,
        amount: formatMoney(donor.vialPrice * vialsOf(donor.ref), testing.currency),
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
  const what = await vialLabel(db, testing);
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
    // What was given goes back too, and so does the extra round.
    await refundDonations(tx, testing);
    await cancelExtra(tx, testing);
    // Orders from outside were only for this testing: with nothing paid they go;
    // with something paid they stay until it is given back.
    await tx
      .update(orders)
      .set({ status: 'cancelled', closedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(orders.externalTestingId, testing.id),
          ne(orders.status, 'cancelled'),
          eq(orders.amountPaid, 0),
          eq(orders.amountSubmitted, 0),
        ),
      );
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
  await notifyTesting(db, env, shop, ids, (lang) => tr(lang, 'testing.cancelled', { shop: shop.name, product: what }));
  return row;
}

/**
 * Who gets the report: those who paid the fee, the donors, and VIPs exempt
 * from the fee who bought what is tested (they see every result).
 */
async function reportAudience(
  db: Database,
  env: Env,
  shop: ShopRow,
  testing: TestingRow,
  options: { onlyVips?: boolean } = {},
): Promise<number[]> {
  const rows = options.onlyVips ? [] : await liveEntries(db, testing.id);
  const donorOrders = (testing.draw?.candidates ?? [])
    .filter((c) => testing.draw?.donors.includes(c.ref))
    .map((c) => c.orderId);
  const paid = rows
    .filter(({ entry, order }) => takesPart(testing, order.isVip, entry.amount) && order.amountPaid >= order.total)
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
  if (options.onlyVips) {
    return audience(
      db,
      env,
      shop,
      vips.map((v) => v.id),
    );
  }
  return audience(db, env, shop, [...new Set([...paid, ...donorOrders, ...vips.map((v) => v.id)])]);
}

/**
 * Who gets the extra round's report: those who paid it and VIPs exempt from
 * the fee; everyone in when one of its tests upgrades a test of theirs.
 */
async function extraReportAudience(db: Database, env: Env, shop: ShopRow, testing: TestingRow): Promise<number[]> {
  const extraIds = testing.extra?.outcome?.tiers ?? [];
  const upgradesBase = testing.tiers.some((t) => extraIds.includes(t.id) && t.replaces && !extraIds.includes(t.replaces));
  if (upgradesBase) return reportAudience(db, env, shop, testing);
  const payers = await extraPayers(db, testing.id);
  const vips = await reportAudience(db, env, shop, testing, { onlyVips: true });
  const own = await audience(db, env, shop, payers);
  return [...new Set([...own, ...vips])];
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
  kind: 'base' | 'extra' = 'base',
): Promise<void> {
  const testing = await findTesting(db, shop.id, id);
  if (kind === 'extra' && (testing.extra?.outcome?.tiers.length ?? 0) === 0) {
    throw ApiError.conflict('report_no_extra', 'The extra round did not get any test');
  }
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
    .set({ reportRequest: { chatId: organiserId, messageId: sent.message_id, kind }, updatedAt: new Date() })
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
    document?: { file_id: string; file_name?: string; mime_type?: string };
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
  const extra = testing.reportRequest?.kind === 'extra';
  const ids = extra ? await extraReportAudience(db, env, shop, testing) : await reportAudience(db, env, shop, testing);
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
  const sentReport = { ...file, sentAt: new Date().toISOString() };
  // Kept for good, with a copy of the file: organisers and participants can look it up later.
  await saveReport(db, telegram, testing, {
    kind: extra ? 'extra' : 'base',
    fileKind: file.kind,
    fileId: file.fileId,
    fileName: message.document?.file_name ?? null,
    mime: message.document?.mime_type ?? null,
    uploadedBy: chatId,
    delivered,
  }).catch((error: unknown) => console.error('Report not kept:', error));
  await db
    .update(testings)
    .set({ ...(extra ? { extraReport: sentReport } : { report: sentReport }), reportRequest: null, updatedAt: new Date() })
    .where(eq(testings.id, testing.id));
  await telegram.sendMessage(chatId, tr(lang, 'testing.reportSent', { count: delivered }));
  return true;
}

/**
 * Where the vials are after the draw: sent to the lab, received there, or
 * the day results are expected. Those who will get a report hear each step.
 */
export async function markLabProgress(
  db: Database,
  env: Env,
  shop: ShopRow,
  id: string,
  step: LabProgressRequest,
): Promise<TestingRow> {
  const testing = await findTesting(db, shop.id, id);
  if (!testing.draw?.hash || (testing.status !== 'drawn' && testing.status !== 'settled')) {
    throw ApiError.conflict('lab_not_drawn', 'Once the donors are drawn');
  }
  const now = new Date().toISOString();
  const progress = {
    ...testing.labProgress,
    ...(step.step === 'sent' ? { sentAt: now } : step.step === 'received' ? { receivedAt: now } : { expected: step.date }),
  };
  const [saved] = await db
    .update(testings)
    .set({ labProgress: progress, updatedAt: new Date() })
    .where(eq(testings.id, testing.id))
    .returning();
  const what = await testedLabel(db, testing);
  const extraIds = testing.extra?.outcome?.tiers ?? [];
  const ids = [
    ...new Set([
      ...(await reportAudience(db, env, shop, testing)),
      ...(extraIds.length > 0 ? await extraReportAudience(db, env, shop, testing) : []),
    ]),
  ];
  const day = (iso: string, lang: Lang): string =>
    new Date(`${iso.length === 10 ? `${iso}T12:00:00` : iso}`).toLocaleDateString(lang);
  await notifyTesting(db, env, shop, ids, (lang) =>
    step.step === 'sent'
      ? tr(lang, 'testing.labSent', { shop: shop.name, product: what, lab: testing.lab })
      : step.step === 'received'
        ? tr(lang, 'testing.labReceived', { shop: shop.name, product: what, lab: testing.lab })
        : tr(lang, 'testing.labExpected', { shop: shop.name, product: what, lab: testing.lab, date: day(step.date, lang) }),
  ).catch((error: unknown) => console.error('Lab notice failed:', error));
  return saved ?? testing;
}
