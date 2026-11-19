import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  EXTRA_PAY_HOURS,
  EXTRA_SIGNUP_HOURS,
  shareOut,
  tierSteps,
  type Lang,
  type Order,
  type TestingExtraState,
  type TestingExtraView,
  type TierStep,
} from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, testingEntries, testingExtraMembers, testings } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { tr } from '../i18n/messages.js';
import { notifyUsers } from './notifications.js';
import { notifyShopTeam } from './webNotices.js';
import { getOrder } from './orders.js';
import type { ShopRow } from './shop.js';
import { botToken } from './activeBot.js';
import { audience, testedLabel } from './testingDraw.js';
import { feeExempt, stepsOf, testingTotals, vialPrices } from './testing.js';
import { dropUnpaidDonations, giversOf, takeOff } from './testingDonations.js';

/**
 * The extra round of a testing: once its time to give is over, those in it
 * sign up with a cap to cover the tests still missing. As many tests as
 * possible are covered, in order, everyone in paying the same share (whoever's
 * cap is below it is out). The shares go on top of the pot, so they only pay
 * tests the pot does not reach; what they do not use goes back.
 */

type TestingRow = typeof testings.$inferSelect;
type Member = typeof testingExtraMembers.$inferSelect;

const formatMoney = (amount: number, currency: string): string => `${(amount / 100).toFixed(2)} ${currency}`;
const hours = (n: number): number => n * 3600_000;

/** The lowest cap to sign up: the one set, or the fee. */
export const extraMin = (row: Pick<TestingRow, 'extraMin' | 'contribution'>): number =>
  row.extraMin > 0 ? row.extraMin : row.contribution;

/** What is still missing, without the extra round's money: per test not covered, adding the ones before. */
async function missingSteps(db: Database, row: TestingRow): Promise<TierStep[]> {
  const totals = (await testingTotals(db, [row.id])).get(row.id);
  if (!totals) return [];
  const price = (await vialPrices(db, [row])).get(row.id) ?? 0;
  return stepsOf({ ...row, status: 'open' }, totals, price, { withoutExtra: true }).filter((s) => !s.reached);
}

/** The time to give is over: the extra round starts when it is on and tests are missing. */
export async function startExtra(db: Database, env: Env, row: TestingRow, now = new Date()): Promise<boolean> {
  if (!row.extraEnabled || row.extra || !row.extraProductId) return false;
  const missing = await missingSteps(db, row);
  if (missing.length === 0) return false;
  const state: TestingExtraState = {
    stage: 'signup',
    until: new Date(now.getTime() + hours(EXTRA_SIGNUP_HOURS)).toISOString(),
    target: [],
    share: 0,
  };
  const [started] = await db
    .update(testings)
    .set({ extra: state, updatedAt: new Date() })
    .where(and(eq(testings.id, row.id), sql`${testings.extra} is null`))
    .returning();
  if (!started) return false;
  const shop = await db.query.shops.findFirst({ where: (s, { eq: same }) => same(s.id, row.shopId) });
  if (!shop) return true;
  const what = await testedLabel(db, row);
  const list = missing
    .map((step, i) => `${step.tier.name}: ${formatMoney(step.missing - (missing[i - 1]?.missing ?? 0), row.currency)}`)
    .join('\n');
  const ids = await giversOf(db, env, shop, row);
  await notifyUsers(db, botToken(env), ids, (lang: Lang) =>
    tr(lang, 'testing.extraOpen', {
      shop: shop.name,
      product: what,
      hours: EXTRA_SIGNUP_HOURS,
      min: formatMoney(extraMin(row), row.currency),
      list,
    }),
  );
  return true;
}

/** Whether this order is in the testing (paid its part): only those can sign up. */
async function isIn(db: Pick<Database, 'select'>, row: TestingRow, order: typeof orders.$inferSelect): Promise<boolean> {
  if (feeExempt(row, order.isVip)) return false;
  const [entry] = await db
    .select({ amount: testingEntries.amount })
    .from(testingEntries)
    .where(and(eq(testingEntries.testingId, row.id), eq(testingEntries.orderId, order.id)));
  return entry !== undefined && entry.amount > 0 && order.amountPaid > 0;
}

/** Signs up (or changes the cap) from an order, while sign-up is open. */
export async function signUpExtra(
  db: Database,
  shop: ShopRow,
  userId: number,
  orderId: string,
  testingId: string,
  cap: number,
): Promise<Order> {
  const row = await db.query.testings.findFirst({ where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)) });
  if (!row) throw ApiError.notFound('Testing not found');
  if (row.extra?.stage !== 'signup') throw ApiError.conflict('extra_closed', 'Signing up to the extra round is over');
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.shopId, shop.id), eq(orders.id, orderId), eq(orders.userId, userId)),
  });
  if (!order || order.status === 'cancelled') throw ApiError.notFound('Order not found');
  if (!(await isIn(db, row, order))) {
    throw ApiError.conflict('extra_not_in', 'Only those who paid their part can sign up');
  }
  if (cap < extraMin(row)) {
    throw ApiError.badRequest('extra_cap_low', `The cap must be at least ${formatMoney(extraMin(row), row.currency)}`);
  }
  await db
    .insert(testingExtraMembers)
    .values({ testingId: row.id, orderId: order.id, userId, cap })
    .onConflictDoUpdate({ target: [testingExtraMembers.testingId, testingExtraMembers.orderId], set: { cap } });
  const dto = await getOrder(db, shop.id, order.id, userId);
  if (!dto) throw ApiError.notFound('Order not found');
  return dto;
}

/** Leaves the extra round, while sign-up is open. */
export async function leaveExtra(db: Database, shop: ShopRow, userId: number, orderId: string, testingId: string): Promise<Order> {
  const row = await db.query.testings.findFirst({ where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)) });
  if (!row) throw ApiError.notFound('Testing not found');
  if (row.extra?.stage !== 'signup') throw ApiError.conflict('extra_closed', 'Signing up to the extra round is over');
  await db
    .delete(testingExtraMembers)
    .where(
      and(
        eq(testingExtraMembers.testingId, row.id),
        eq(testingExtraMembers.orderId, orderId),
        eq(testingExtraMembers.userId, userId),
      ),
    );
  const dto = await getOrder(db, shop.id, orderId, userId);
  if (!dto) throw ApiError.notFound('Order not found');
  return dto;
}

/** How the extra round stands, for one customer (or the organiser). */
export async function extraViews(
  db: Database,
  rows: readonly TestingRow[],
  userId?: number,
): Promise<Map<string, TestingExtraView>> {
  const result = new Map<string, TestingExtraView>();
  const live = rows.filter((r) => r.extra);
  if (live.length === 0) return result;
  const members = await db
    .select()
    .from(testingExtraMembers)
    .where(
      inArray(
        testingExtraMembers.testingId,
        live.map((r) => r.id),
      ),
    );
  for (const row of live) {
    const extra = row.extra as TestingExtraState;
    const missing = await missingSteps(db, row);
    const needs = missing.map((s) => s.missing);
    const own = members.filter((m) => m.testingId === row.id);
    const mine = userId === undefined ? undefined : own.find((m) => m.userId === userId);
    const signed = own.filter((m) => m.state !== 'out');
    const estimate =
      extra.stage === 'signup'
        ? shareOut(
            signed.map((m) => ({ key: m.id, cap: m.cap })),
            needs,
          )
        : null;
    result.set(row.id, {
      stage: extra.stage,
      until: extra.until,
      min: extraMin(row),
      missing: missing.map((s, i) => ({
        id: s.tier.id,
        name: s.tier.name,
        amount: s.missing - (missing[i - 1]?.missing ?? 0),
      })),
      signed: signed.length,
      mine: mine ? { cap: mine.cap, share: mine.share, state: mine.state, orderId: mine.orderId } : null,
      estimate:
        extra.stage === 'signup'
          ? {
              tiers: estimate ? missing.slice(0, estimate.count).map((s) => s.tier.name) : [],
              share: estimate?.share ?? null,
              out: mine ? !estimate || !estimate.keys.includes(mine.id) : false,
            }
          : {
              tiers: row.tiers.filter((t) => extra.target.includes(t.id)).map((t) => t.name),
              share: extra.share || null,
              out: mine?.state === 'out',
            },
      outcome: extra.outcome ?? null,
    });
  }
  return result;
}

/** Sign-up is over: the shares are worked out and added to the orders of those in. */
async function shareOutExtra(db: Database, env: Env, shop: ShopRow, row: TestingRow, now: Date): Promise<void> {
  const members = await db.select().from(testingExtraMembers).where(eq(testingExtraMembers.testingId, row.id));
  const missing = await missingSteps(db, row);
  const plan = shareOut(
    members.map((m) => ({ key: m.id, cap: m.cap })),
    missing.map((s) => s.missing),
  );
  const what = await testedLabel(db, row);
  if (!plan || plan.keys.length === 0 || !row.extraProductId) {
    await db
      .update(testings)
      .set({
        extra: { ...(row.extra as TestingExtraState), stage: 'done', outcome: { tiers: [], collected: 0, refunded: 0 } },
        updatedAt: new Date(),
      })
      .where(eq(testings.id, row.id));
    const ids = await audience(
      db,
      env,
      shop,
      members.map((m) => m.orderId),
    );
    await notifyUsers(db, botToken(env), ids, (lang) => tr(lang, 'testing.extraNone', { shop: shop.name, product: what }));
    return;
  }
  const target = missing.slice(0, plan.count).map((s) => s.tier.id);
  const productId = row.extraProductId;
  // From here on, gifts go to the GB: they do not lower what the extra round pays.
  const totalsNow = (await testingTotals(db, [row.id])).get(row.id);
  const basePot = totalsNow
    ? totalsNow.fees + totalsNow.extras + totalsNow.donations + row.perUnit * totalsNow.units
    : 0;
  // The exact sum, shared out: a cent more for some (highest caps first), so nothing is left over.
  const need = missing[plan.count - 1]?.missing ?? 0;
  const each = Math.floor(need / plan.keys.length);
  const extraCents = need - each * plan.keys.length;
  const byCap = members.filter((m) => plan.keys.includes(m.id)).sort((a, b) => b.cap - a.cap);
  const amountOf = new Map(byCap.map((m, i) => [m.id, each + (i < extraCents ? 1 : 0)]));
  await db.transaction(async (tx) => {
    for (const member of members) {
      const inside = plan.keys.includes(member.id);
      const amount = amountOf.get(member.id) ?? 0;
      await tx
        .update(testingExtraMembers)
        .set({ state: inside ? 'in' : 'out', share: inside ? amount : 0 })
        .where(eq(testingExtraMembers.id, member.id));
      if (!inside) continue;
      const [order] = await tx.select().from(orders).where(eq(orders.id, member.orderId)).for('update');
      if (!order || order.status === 'cancelled') continue;
      await tx.insert(orderItems).values({
        orderId: order.id,
        productId,
        title: `Fase extra · ${what} (testing)`,
        titleEn: `Extra round · ${what} (testing)`,
        unitPrice: amount,
        quantity: 1,
        subtotal: amount,
        donationUnpaid: 1,
      });
      const sent = order.status === 'shipped' || order.status === 'fulfilled';
      await tx
        .update(orders)
        .set({
          total: order.total + amount,
          status: order.status === 'awaiting_payment' ? order.status : 'pending',
          resumeStatus: sent ? order.status : order.resumeStatus,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));
    }
    await tx
      .update(testings)
      .set({
        extra: {
          stage: 'pay',
          until: new Date(now.getTime() + hours(EXTRA_PAY_HOURS)).toISOString(),
          target,
          share: plan.share,
          basePot,
        },
        updatedAt: new Date(),
      })
      .where(eq(testings.id, row.id));
  });
  const names = row.tiers.filter((t) => target.includes(t.id)).map((t) => t.name).join(', ');
  const outOrders = members.filter((m) => !plan.keys.includes(m.id)).map((m) => m.orderId);
  // Each one their own amount.
  for (const member of byCap) {
    await notifyUsers(db, botToken(env), await audience(db, env, shop, [member.orderId]), (lang) =>
      tr(lang, 'testing.extraPay', {
        shop: shop.name,
        product: what,
        tiers: names,
        amount: formatMoney(amountOf.get(member.id) ?? plan.share, row.currency),
        hours: EXTRA_PAY_HOURS,
      }),
    );
  }
  await notifyUsers(db, botToken(env), await audience(db, env, shop, outOrders), (lang) =>
    tr(lang, 'testing.extraOut', { shop: shop.name, product: what, amount: formatMoney(plan.share, row.currency) }),
  );
}

/**
 * Paying is over: who did not pay drops out (their share comes off their
 * order), and what was paid covers what it can, in order, on top of the pot
 * as it was when shared out (later gifts go to the GB). If it covers no test,
 * everything goes back; otherwise only what is left over (cents of rounding).
 */
async function settleExtra(db: Database, env: Env, shop: ShopRow, row: TestingRow): Promise<void> {
  if (!row.extraProductId) return;
  const productId = row.extraProductId;
  const members = await db
    .select({ member: testingExtraMembers, order: orders })
    .from(testingExtraMembers)
    .innerJoin(orders, eq(testingExtraMembers.orderId, orders.id))
    .where(and(eq(testingExtraMembers.testingId, row.id), eq(testingExtraMembers.state, 'in')));
  const lines = await db
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.productId, productId),
        inArray(
          orderItems.orderId,
          members.length > 0 ? members.map((m) => m.order.id) : ['00000000-0000-0000-0000-000000000000'],
        ),
      ),
    );
  const paidIds: string[] = [];
  const failed: Array<{ member: Member; order: typeof orders.$inferSelect }> = [];
  for (const { member, order } of members) {
    const line = lines.find((l) => l.orderId === order.id);
    if (line && line.donationUnpaid === 0 && order.status !== 'cancelled') paidIds.push(member.id);
    else failed.push({ member, order });
  }
  // Unpaid shares come off (the order goes back to where it was).
  await db.transaction(async (tx) => {
    for (const { member, order } of failed) {
      await takeOff(tx, order, [productId], true);
      await tx.update(testingExtraMembers).set({ state: 'failed' }).where(eq(testingExtraMembers.id, member.id));
    }
    if (paidIds.length > 0) {
      await tx.update(testingExtraMembers).set({ state: 'paid' }).where(inArray(testingExtraMembers.id, paidIds));
    }
  });
  // Donations made meanwhile and not paid come off too.
  await dropUnpaidDonations(db, [row]);

  // What the paid shares reach on top of the pot; what they do not use goes back.
  const totals = (await testingTotals(db, [row.id])).get(row.id);
  const price = (await vialPrices(db, [row])).get(row.id) ?? 0;
  const collected = totals?.extraPaid ?? 0;
  let tiersDone: string[] = [];
  let unused = collected;
  if (totals && collected > 0) {
    const extra = row.extra as TestingExtraState;
    const pot = extra.basePot ?? totals.fees + totals.extras + totals.donations + row.perUnit * totals.units;
    const steps = tierSteps({ tiers: row.tiers, pot: pot + collected, vialPrice: price, unitValue: 0 });
    const before = tierSteps({ tiers: row.tiers, pot, vialPrice: price, unitValue: 0 });
    const baseReached = new Set(before.filter((s) => s.reached).map((s) => s.tier.id));
    const extraSteps = steps.filter((s) => s.reached && !baseReached.has(s.tier.id));
    tiersDone = extraSteps.map((s) => s.tier.id);
    const last = extraSteps[extraSteps.length - 1];
    unused = last ? Math.min(Math.max(pot + collected - last.needed, 0), collected) : collected;
  }
  const paidMembers = members.filter(({ member }) => paidIds.includes(member.id));
  let refunded = 0;
  if (unused > 0 && paidMembers.length > 0) {
    // In equal parts (a cent more for the first ones, when it does not divide).
    const part = Math.floor(unused / paidMembers.length);
    let rest = unused - part * paidMembers.length;
    await db.transaction(async (tx) => {
      for (const { order } of paidMembers) {
        const back = part + (rest > 0 ? 1 : 0);
        if (rest > 0) rest -= 1;
        if (back <= 0) continue;
        const line = lines.find((l) => l.orderId === order.id);
        if (!line) continue;
        const [fresh] = await tx.select().from(orders).where(eq(orders.id, order.id)).for('update');
        if (!fresh) continue;
        const left = Math.max(line.unitPrice - back, 0);
        if (left === 0) await tx.delete(orderItems).where(eq(orderItems.id, line.id));
        else await tx.update(orderItems).set({ unitPrice: left, subtotal: left }).where(eq(orderItems.id, line.id));
        // Paid already: lowering the total leaves it owed back (the usual refund).
        await tx
          .update(orders)
          .set({ total: fresh.total - (line.unitPrice - left), updatedAt: new Date() })
          .where(eq(orders.id, fresh.id));
        refunded += line.unitPrice - left;
      }
    });
  }
  await db
    .update(testings)
    .set({
      extra: { ...(row.extra as TestingExtraState), stage: 'done', outcome: { tiers: tiersDone, collected, refunded } },
      updatedAt: new Date(),
    })
    .where(eq(testings.id, row.id));

  const what = await testedLabel(db, row);
  const names = row.tiers.filter((t) => tiersDone.includes(t.id)).map((t) => t.name).join(', ');
  await notifyUsers(
    db,
    botToken(env),
    await audience(
      db,
      env,
      shop,
      paidMembers.map((m) => m.order.id),
    ),
    (lang) =>
      tiersDone.length > 0
        ? tr(lang, 'testing.extraDone', { shop: shop.name, product: what, tiers: names })
        : tr(lang, 'testing.extraFailed', { shop: shop.name, product: what }),
  );
  if (failed.length > 0) {
    const who = failed.map(({ order }) => `#${order.id.slice(0, 8)}${order.contactUsername ? ` @${order.contactUsername}` : ''}`).join(', ');
    await notifyShopTeam(db, env, shop, (lang) =>
      tr(lang, 'testing.extraUnpaid', { shop: shop.name, product: what, who }),
    ).catch((error: unknown) => console.error('Extra round notice failed:', error));
  }
}

/** A day into paying: those in who have not paid yet are reminded. */
async function remindExtra(db: Database, env: Env, shop: ShopRow, row: TestingRow): Promise<void> {
  const extra = row.extra as TestingExtraState;
  await db
    .update(testings)
    .set({ extra: { ...extra, reminded: true } })
    .where(eq(testings.id, row.id));
  if (!row.extraProductId) return;
  const unpaid = await db
    .selectDistinct({ id: orders.id, share: testingExtraMembers.share })
    .from(testingExtraMembers)
    .innerJoin(orders, eq(testingExtraMembers.orderId, orders.id))
    .innerJoin(orderItems, and(eq(orderItems.orderId, orders.id), eq(orderItems.productId, row.extraProductId)))
    .where(
      and(
        eq(testingExtraMembers.testingId, row.id),
        eq(testingExtraMembers.state, 'in'),
        sql`${orderItems.donationUnpaid} > 0`,
        ne(orders.status, 'cancelled'),
      ),
    );
  const what = await testedLabel(db, row);
  for (const u of unpaid) {
    await notifyUsers(db, botToken(env), await audience(db, env, shop, [u.id]), (lang) =>
      tr(lang, 'testing.extraRemind', { shop: shop.name, product: what, amount: formatMoney(u.share, row.currency) }),
    );
  }
}

/** Every minute: moves each extra round along (sign-up → shares → paying → done). */
export async function advanceExtras(db: Database, env: Env, now = new Date()): Promise<void> {
  const rows = await db
    .select()
    .from(testings)
    .where(and(eq(testings.status, 'closed'), sql`${testings.extra}->>'stage' in ('signup', 'pay')`));
  for (const row of rows) {
    const extra = row.extra as TestingExtraState;
    const shop = await db.query.shops.findFirst({ where: (s, { eq: same }) => same(s.id, row.shopId) });
    if (!shop) continue;
    const until = new Date(extra.until);
    try {
      if (extra.stage === 'signup' && until <= now) {
        await shareOutExtra(db, env, shop, row, now);
      } else if (extra.stage === 'pay' && until <= now) {
        await settleExtra(db, env, shop, row);
      } else if (extra.stage === 'pay' && !extra.reminded && until.getTime() - now.getTime() <= hours(EXTRA_PAY_HOURS / 2)) {
        await remindExtra(db, env, shop, row);
      }
    } catch (error) {
      console.error('Extra round step failed:', error);
    }
  }
}

/**
 * The GB is opened again, or the testing cancelled: the extra round stops and
 * every share comes off its order (what was paid is owed back).
 */
export async function cancelExtra(tx: Pick<Database, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete'>, row: TestingRow): Promise<void> {
  if (!row.extra) return;
  if (row.extraProductId) {
    const rows = await tx
      .selectDistinct({ order: orders })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(and(eq(orderItems.productId, row.extraProductId), ne(orders.status, 'cancelled')));
    for (const { order } of rows) await takeOff(tx, order, [row.extraProductId], false);
  }
  await tx.delete(testingExtraMembers).where(eq(testingExtraMembers.testingId, row.id));
  await tx.update(testings).set({ extra: null, updatedAt: new Date() }).where(eq(testings.id, row.id));
}

/** The extra round is still going: the draw waits for it. */
export const extraGoing = (row: Pick<TestingRow, 'extra'>): boolean =>
  row.extra !== null && row.extra.stage !== 'done';

/** Who paid the extra round (their orders): they get its report, and its vials come from them. */
export async function extraPayers(db: Database, testingId: string): Promise<string[]> {
  const rows = await db
    .select({ orderId: testingExtraMembers.orderId })
    .from(testingExtraMembers)
    .where(and(eq(testingExtraMembers.testingId, testingId), eq(testingExtraMembers.state, 'paid')));
  return rows.map((r) => r.orderId);
}
