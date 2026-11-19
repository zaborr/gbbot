import { and, eq, gt, inArray, isNull, lte, ne } from 'drizzle-orm';
import { DONATION_UNIT, MAX_DONATION, type Lang, type Order } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, testingEntries, testings } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { tr } from '../i18n/messages.js';
import { notifyUsers } from './notifications.js';
import { notifyShopTeam } from './webNotices.js';
import { getOrder } from './orders.js';
import type { ShopRow } from './shop.js';
import { botToken } from './activeBot.js';
import { audience, testedLabel } from './testingDraw.js';
import { cancelExtra, startExtra } from './testingExtra.js';
import {
  dropUnpaidTesting,
  donationsOpen,
  feeExempt,
  progressText,
  stepsOf,
  testingTotals,
  vialPrices,
} from './testing.js';

/**
 * Giving to a testing: those in it (they paid their part, or are exempt VIPs)
 * add a line of its donation product (1 a unit) to their order, whatever its
 * state, and pay it the usual way. Open while the testing is; once the GB
 * closes, for some hours more. What is not paid when the time is up comes off
 * again; what was paid stays in the pot.
 */

type TestingRow = typeof testings.$inferSelect;
export type Writer = Pick<Database, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete'>;

/** Formats an amount the way the bot does. */
const formatMoney = (amount: number, currency: string): string => `${(amount / 100).toFixed(2)} ${currency}`;

/** Whether this order can give to this testing: it has what is tested and took part (or is exempt). */
async function mayGive(tx: Writer, testing: TestingRow, order: typeof orders.$inferSelect): Promise<boolean> {
  const items = await tx
    .select({ productId: orderItems.productId, variantId: orderItems.variantId })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const bought = items.some(
    (i) => i.productId === testing.productId && (testing.variantId === null || i.variantId === testing.variantId),
  );
  if (!bought) return false;
  if (feeExempt(testing, order.isVip)) return true;
  const [entry] = await tx
    .select({ amount: testingEntries.amount })
    .from(testingEntries)
    .where(and(eq(testingEntries.testingId, testing.id), eq(testingEntries.orderId, order.id)));
  return entry !== undefined && entry.amount > 0;
}

/**
 * Adds what the customer gives (whole units) to their order: the order then
 * waits for that payment. Giving again to the same testing adds to its line.
 */
export async function addDonation(
  db: Database,
  shop: ShopRow,
  userId: number,
  orderId: string,
  testingId: string,
  amount: number,
): Promise<Order> {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.shopId, shop.id), eq(orders.id, orderId), eq(orders.userId, userId)))
      .for('update');
    if (!order) throw ApiError.notFound('Order not found');
    const testing = await tx.query.testings.findFirst({
      where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)),
    });
    if (!testing || !testing.donationProductId) throw ApiError.notFound('Testing not found');
    if (!donationsOpen(testing)) throw ApiError.conflict('donations_closed', 'The time to give to this testing is over');
    if (testing.currency !== order.currency) {
      throw ApiError.conflict('mixed_currency', `This order is in ${order.currency}`);
    }
    // Any state but cancelled, as long as no payment is being checked.
    const payable =
      ['pending', 'paid', 'shipped', 'fulfilled'].includes(order.status) && order.amountSubmitted === 0;
    if (!payable) throw ApiError.conflict('donation_order_state', 'Wait until your payment is checked, then you can give');
    if (!(await mayGive(tx, testing, order))) {
      throw ApiError.conflict('donation_not_buyer', 'Only those who bought it and pay its testing can give');
    }
    // Giving again adds to the same line (its units not paid yet are kept apart).
    const [line] = await tx
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), eq(orderItems.productId, testing.donationProductId)));
    const units = (line?.quantity ?? 0) + amount / DONATION_UNIT;
    if (units * DONATION_UNIT > MAX_DONATION) {
      throw ApiError.badRequest('donation_too_big', 'That is more than can be given at once');
    }
    if (line) {
      await tx
        .update(orderItems)
        .set({
          quantity: units,
          subtotal: units * DONATION_UNIT,
          donationUnpaid: line.donationUnpaid + amount / DONATION_UNIT,
        })
        .where(eq(orderItems.id, line.id));
    } else {
      const product = await tx.query.products.findFirst({
        where: (p, { eq: same }) => same(p.id, testing.donationProductId ?? ''),
      });
      await tx.insert(orderItems).values({
        orderId: order.id,
        productId: testing.donationProductId,
        title: product?.title ?? 'Donación (testing)',
        titleEn: product?.titleEn ?? null,
        unitPrice: DONATION_UNIT,
        quantity: units,
        subtotal: units * DONATION_UNIT,
        donationUnpaid: units,
      });
    }
    // It waits for that payment; sent already, it remembers to go back to sent.
    const sent = order.status === 'shipped' || order.status === 'fulfilled';
    await tx
      .update(orders)
      .set({
        total: order.total + amount,
        status: 'pending',
        resumeStatus: sent ? order.status : order.resumeStatus,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));
  });
  const order = await getOrder(db, shop.id, orderId, userId);
  if (!order) throw ApiError.notFound('Order not found');
  return order;
}

/** Takes back what the customer gave to a testing, while it is not paid. */
export async function removeDonation(
  db: Database,
  shop: ShopRow,
  userId: number,
  orderId: string,
  testingId: string,
): Promise<Order> {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.shopId, shop.id), eq(orders.id, orderId), eq(orders.userId, userId)))
      .for('update');
    if (!order) throw ApiError.notFound('Order not found');
    const testing = await tx.query.testings.findFirst({
      where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)),
    });
    if (!testing?.donationProductId) throw ApiError.notFound('Testing not found');
    if (order.amountSubmitted > 0) {
      throw ApiError.conflict('donation_paid', 'This donation is paid or its payment is being checked');
    }
    await takeOff(tx, order, [testing.donationProductId], true);
  });
  const order = await getOrder(db, shop.id, orderId, userId);
  if (!order) throw ApiError.notFound('Order not found');
  return order;
}

/**
 * Takes donations to these products off an order: only what is not paid yet,
 * or all of it (what was paid is then owed back).
 */
export async function takeOff(
  tx: Writer,
  order: typeof orders.$inferSelect,
  productIds: readonly string[],
  onlyUnpaid: boolean,
): Promise<number> {
  const lines = await tx
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), inArray(orderItems.productId, [...productIds])));
  let amount = 0;
  for (const line of lines) {
    const units = onlyUnpaid ? Math.min(line.donationUnpaid, line.quantity) : line.quantity;
    if (units <= 0) continue;
    amount += units * line.unitPrice;
    const left = line.quantity - units;
    if (left <= 0) {
      await tx.delete(orderItems).where(eq(orderItems.id, line.id));
    } else {
      await tx
        .update(orderItems)
        .set({ quantity: left, subtotal: left * line.unitPrice, donationUnpaid: 0 })
        .where(eq(orderItems.id, line.id));
    }
  }
  if (amount === 0) return 0;
  const total = order.total - amount;
  await tx
    .update(orders)
    .set({
      total,
      // Nothing left to pay: back to paid, or sent (a donation paid and taken off is owed back).
      status: order.status === 'pending' && order.amountPaid >= total ? (order.resumeStatus ?? 'paid') : order.status,
      resumeStatus: order.status === 'pending' && order.amountPaid >= total ? null : order.resumeStatus,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, order.id));
  return amount;
}

/**
 * Donation lines not paid (and with no payment being checked) come off their
 * orders: for one testing, or all of a GB's.
 */
export async function dropUnpaidDonations(db: Database, rows: readonly TestingRow[]): Promise<number> {
  const productIds = rows.flatMap((r) => (r.donationProductId ? [r.donationProductId] : []));
  if (productIds.length === 0) return 0;
  const pending = await db
    .selectDistinct({ order: orders })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        inArray(orderItems.productId, productIds),
        gt(orderItems.donationUnpaid, 0),
        ne(orders.status, 'cancelled'),
        eq(orders.amountSubmitted, 0),
      ),
    );
  for (const { order } of pending) {
    await db.transaction(async (tx) => {
      await takeOff(tx, order, productIds, true);
    });
  }
  return pending.length;
}

/**
 * Someone gave to it and their payment is still being checked: the draw waits
 * for it (or for it to be rejected).
 */
export async function donationsBeingChecked(db: Database, testing: TestingRow): Promise<boolean> {
  if (!testing.donationProductId) return false;
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orderItems.productId, testing.donationProductId),
        gt(orderItems.donationUnpaid, 0),
        ne(orders.status, 'cancelled'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Who bought what a testing tests and takes part (or is exempt): they hear they can give. */
export async function giversOf(db: Database, env: Env, shop: ShopRow, testing: TestingRow): Promise<number[]> {
  const rows = await db
    .selectDistinct({ id: orders.id, isVip: orders.isVip, entry: testingEntries.amount })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .leftJoin(
      testingEntries,
      and(eq(testingEntries.orderId, orders.id), eq(testingEntries.testingId, testing.id)),
    )
    .where(
      and(
        eq(orders.shopId, shop.id),
        ne(orders.status, 'cancelled'),
        eq(orderItems.productId, testing.productId),
        testing.variantId ? eq(orderItems.variantId, testing.variantId) : undefined,
      ),
    );
  const ids = rows
    .filter((r) => (r.entry ?? 0) > 0 || feeExempt(testing, r.isVip))
    .map((r) => r.id);
  return audience(db, env, shop, ids);
}

/**
 * The GB has just closed: each of its testings that are closed now opens its
 * time to give, and its buyers are told how far the next tier is.
 */
export async function openDonationWindows(db: Database, env: Env, shop: ShopRow, now = new Date()): Promise<void> {
  const rows = await db
    .select()
    .from(testings)
    .where(
      and(
        eq(testings.shopId, shop.id),
        eq(testings.status, 'closed'),
        isNull(testings.donationsUntil),
        eq(testings.donationsDone, false),
      ),
    );
  if (rows.length === 0) return;
  const totals = await testingTotals(
    db,
    rows.map((r) => r.id),
  );
  const prices = await vialPrices(db, rows);
  for (const row of rows) {
    const until = new Date(now.getTime() + row.donationHours * 3600_000);
    // No time after closing: nothing to announce, it ends with the GB.
    const [opened] = await db
      .update(testings)
      .set({ donationsUntil: until, updatedAt: new Date() })
      .where(and(eq(testings.id, row.id), isNull(testings.donationsUntil)))
      .returning();
    if (!opened) continue;
    const t = totals.get(row.id);
    const steps = t ? stepsOf(opened, t, prices.get(row.id) ?? 0) : [];
    const next = steps.find((s) => !s.reached);
    // Nothing left to reach (or no time to give): no point asking for more.
    if (!next || row.donationHours === 0) continue;
    const what = await testedLabel(db, row);
    const ids = await giversOf(db, env, shop, row);
    await notifyUsers(db, botToken(env), ids, (lang: Lang) =>
      [
        tr(lang, next.unitsLeft !== null ? 'testing.donationsOpen' : 'testing.donationsOpenShare', {
          shop: shop.name,
          product: what,
          tier: next.tier.name,
          units: next.unitsLeft ?? 0,
          percent: Math.floor(next.share * 100),
          hours: row.donationHours,
        }),
        progressText(lang, steps, false),
      ].join('\n\n'),
    );
  }
}

/** A day before the time to give ends: those in it hear how far the next test is. */
async function remindDonations(db: Database, env: Env, now: Date): Promise<void> {
  const soon = new Date(now.getTime() + 24 * 3600_000);
  const rows = await db
    .select()
    .from(testings)
    .where(
      and(
        eq(testings.status, 'closed'),
        eq(testings.donationsDone, false),
        eq(testings.donationsReminded, false),
        lte(testings.donationsUntil, soon),
        gt(testings.donationHours, 24),
      ),
    );
  for (const row of rows) {
    const [claimed] = await db
      .update(testings)
      .set({ donationsReminded: true })
      .where(and(eq(testings.id, row.id), eq(testings.donationsReminded, false)))
      .returning();
    if (!claimed || !claimed.donationsUntil || claimed.donationsUntil <= now) continue;
    const shop = await db.query.shops.findFirst({ where: (s, { eq: same }) => same(s.id, row.shopId) });
    const totals = (await testingTotals(db, [row.id])).get(row.id);
    if (!shop || !totals) continue;
    const steps = stepsOf(claimed, totals, (await vialPrices(db, [claimed])).get(row.id) ?? 0);
    if (!steps.some((s) => !s.reached)) continue;
    const what = await testedLabel(db, row);
    const hours = Math.max(Math.round((claimed.donationsUntil.getTime() - now.getTime()) / 3600_000), 1);
    const ids = await giversOf(db, env, shop, row);
    await notifyUsers(db, botToken(env), ids, (lang: Lang) =>
      [
        tr(lang, 'testing.donationsReminder', { shop: shop.name, product: what, hours }),
        progressText(lang, steps, true),
      ].join('\n\n'),
    );
  }
}

/**
 * A testing has just been created in an open GB: those who already bought
 * what it tests hear they can join it from their order (and then give).
 */
export async function announceNewTesting(db: Database, env: Env, shop: ShopRow, testingId: string): Promise<void> {
  const row = await db.query.testings.findFirst({ where: eq(testings.id, testingId) });
  if (!row || (shop.closedAt && !row.posterior)) return;
  const buyers = await db
    .selectDistinct({ id: orders.id })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        eq(orders.shopId, shop.id),
        ne(orders.status, 'cancelled'),
        eq(orderItems.productId, row.productId),
        row.variantId ? eq(orderItems.variantId, row.variantId) : undefined,
      ),
    );
  if (buyers.length === 0) return;
  const ids = await audience(
    db,
    env,
    shop,
    buyers.map((b) => b.id),
  );
  const what = await testedLabel(db, row);
  const totals = (await testingTotals(db, [row.id])).get(row.id);
  const steps = totals ? stepsOf(row, totals, (await vialPrices(db, [row])).get(row.id) ?? 0) : [];
  await notifyUsers(db, botToken(env), ids, (lang: Lang) =>
    [
      tr(lang, row.posterior ? 'testing.announcedAfter' : 'testing.announced', {
        shop: shop.name,
        product: what,
        lab: row.lab,
        amount: formatMoney(row.contribution, row.currency),
        hours: row.donationHours,
      }),
      progressText(lang, steps, true),
    ].join('\n\n'),
  );
}

/** Every minute: the time to give that is over closes, and unpaid donations come off. */
export async function closeDonationWindows(db: Database, env: Env, now = new Date()): Promise<void> {
  await remindDonations(db, env, now).catch((error: unknown) => console.error('Donation reminder failed:', error));
  // Over already: a payment rejected since leaves its donation unpaid; it comes off too.
  const over = await db
    .select()
    .from(testings)
    .where(and(eq(testings.donationsDone, true), eq(testings.status, 'closed')));
  if (over.length > 0) await dropUnpaidDonations(db, over);
  const rows = await db
    .select()
    .from(testings)
    .where(and(eq(testings.donationsDone, false), lte(testings.donationsUntil, now)));
  for (const row of rows) {
    const [claimed] = await db
      .update(testings)
      .set({ donationsDone: true, updatedAt: new Date() })
      .where(and(eq(testings.id, row.id), eq(testings.donationsDone, false)))
      .returning();
    if (!claimed) continue;
    await dropUnpaidDonations(db, [claimed]);
    // After closing: parts not paid in time drop out too.
    if (claimed.posterior) await dropUnpaidTesting(db, claimed.shopId);
    // Tests still missing: the extra round starts (when it is on).
    const fresh = await db.query.testings.findFirst({ where: eq(testings.id, claimed.id) });
    if (fresh) await startExtra(db, env, fresh).catch((error: unknown) => console.error('Extra round failed to start:', error));
    const shop = await db.query.shops.findFirst({ where: (s, { eq: same }) => same(s.id, row.shopId) });
    if (!shop) continue;
    const what = await testedLabel(db, row);
    const given = (await testingTotals(db, [row.id])).get(row.id)?.donations ?? 0;
    await notifyShopTeam(db, env, shop, (lang) =>
      tr(lang, 'testing.donationsOver', {
        shop: shop.name,
        product: what,
        amount: formatMoney(given, row.currency),
      }),
    ).catch((error: unknown) => console.error('Donations notice failed:', error));
  }
}

/** The GB is opened again: the time to give is cancelled; what was paid stays. */
export async function cancelDonationWindows(db: Database, shop: ShopRow): Promise<void> {
  const rows = await db
    .select()
    .from(testings)
    .where(and(eq(testings.shopId, shop.id), inArray(testings.status, ['closed', 'drawing', 'drawn'])));
  if (rows.length === 0) return;
  await dropUnpaidDonations(db, rows);
  // The extra round stops too (its shares come off; what was paid is owed back).
  for (const row of rows) await db.transaction((tx) => cancelExtra(tx, row));
  await db
    .update(testings)
    .set({ donationsUntil: null, donationsDone: false, donationsReminded: false, updatedAt: new Date() })
    .where(
      inArray(
        testings.id,
        rows.map((r) => r.id),
      ),
    );
}

/** A testing is cancelled: what was given to it comes off the orders (and is owed back when paid). */
export async function refundDonations(tx: Writer, testing: TestingRow): Promise<void> {
  if (!testing.donationProductId) return;
  const rows = await tx
    .selectDistinct({ order: orders })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(and(eq(orderItems.productId, testing.donationProductId), ne(orders.status, 'cancelled')));
  for (const { order } of rows) await takeOff(tx, order, [testing.donationProductId], false);
}
