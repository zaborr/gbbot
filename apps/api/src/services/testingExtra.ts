import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
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
import { orderItems, orders, products, testingEntries, testingExtraMembers, testings } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { tr } from '../i18n/messages.js';
import { notifyShopTeam } from './webNotices.js';
import { getOrder } from './orders.js';
import type { ShopRow } from './shop.js';
import { notifyTesting, audience, testedLabel } from './testingDraw.js';
import { feeExempt, joinOpen, stepsOf, takesPart, testingTotals, vialPrices } from './testing.js';
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

/**
 * Signing up early: the extra round is on but not started, and the testing
 * still takes people (open, or its time to join after closing lasts).
 */
export const preOpen = (row: TestingRow): boolean => row.extraEnabled && row.extra === null && joinOpen(row);

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

/**
 * The extra round can be opened by hand: the time to join and give is over,
 * it is on, and it never started (or ended without any test).
 */
export const extraCanOpen = (row: TestingRow): boolean =>
  row.status === 'closed' &&
  row.extraEnabled &&
  row.donationsDone &&
  (row.extra === null || (row.extra.stage === 'done' && (row.extra.outcome?.tiers.length ?? 0) === 0));

/**
 * The hidden product whose order lines are the extra round's shares. Testings
 * made before the extra round existed have none: it is made when needed.
 */
async function ensureExtraProduct(db: Database, row: TestingRow): Promise<TestingRow> {
  if (row.extraProductId) return row;
  const product = await db.query.products.findFirst({ where: (p, { eq: same }) => same(p.id, row.productId) });
  if (!product) return row;
  const what = await testedLabel(db, row);
  const [extra] = await db
    .insert(products)
    .values({
      shopId: row.shopId,
      slug: `extra-${product.slug}-${Math.random().toString(36).slice(2, 8)}`,
      title: `Fase «Pagar» · ${what} (testing)`,
      titleEn: `«Pay» round · ${what} (testing)`,
      price: 1,
      currency: row.currency,
      isActive: false,
      kind: 'extra',
    })
    .returning({ id: products.id });
  if (!extra) return row;
  const [updated] = await db
    .update(testings)
    .set({ extraProductId: extra.id })
    .where(and(eq(testings.id, row.id), sql`${testings.extraProductId} is null`))
    .returning();
  // Someone else made it meanwhile: theirs stays, this one goes.
  if (!updated) {
    await db.delete(products).where(eq(products.id, extra.id));
    return (await db.query.testings.findFirst({ where: eq(testings.id, row.id) })) ?? row;
  }
  return updated;
}

/**
 * The organisers open the extra round by hand (it never started, or it got
 * nothing): a new time of `hours` to set caps, for everyone in the testing.
 */
export async function openExtra(db: Database, env: Env, shopId: string, id: string, hours: number): Promise<void> {
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 14) throw ApiError.badRequest('bad_hours', 'Hours out of range');
  const row = await db.query.testings.findFirst({ where: and(eq(testings.shopId, shopId), eq(testings.id, id)) });
  if (!row) throw ApiError.notFound('Testing not found');
  if (!extraCanOpen(row)) throw ApiError.conflict('extra_not_openable', 'The extra round cannot be opened now');
  let fresh = row;
  if (row.extra !== null) {
    // The one that got nothing goes: nobody paid anything in it.
    await db.delete(testingExtraMembers).where(eq(testingExtraMembers.testingId, row.id));
    const [reset] = await db
      .update(testings)
      .set({ extra: null, updatedAt: new Date() })
      .where(and(eq(testings.id, row.id), sql`${testings.extra} is not null`))
      .returning();
    if (!reset) throw ApiError.conflict('extra_not_openable', 'The extra round cannot be opened now');
    fresh = reset;
  }
  if (!(await startExtra(db, env, fresh, new Date(), hours))) {
    throw ApiError.conflict('extra_nothing_missing', 'No test is missing: there is nothing to pay for');
  }
}

/** The time to give is over: the extra round starts when it is on and tests are missing. */
export async function startExtra(
  db: Database,
  env: Env,
  current: TestingRow,
  now = new Date(),
  signupHours = current.extraSignupHours,
): Promise<boolean> {
  if (current.extra) return false;
  const row = current.extraEnabled ? await ensureExtraProduct(db, current) : current;
  const early = await earlyMembers(db, row);
  const missing = row.extraEnabled && row.extraProductId ? await missingSteps(db, row) : [];
  if (missing.length === 0) {
    // Signed up early, but no extra round after all (covered, or turned off): nothing to pay.
    if (early.length > 0) {
      await db.delete(testingExtraMembers).where(eq(testingExtraMembers.testingId, row.id));
      const shop = await db.query.shops.findFirst({ where: (s, { eq: same }) => same(s.id, row.shopId) });
      if (shop) {
        const what = await testedLabel(db, row);
        const ids = await audience(
          db,
          env,
          shop,
          early.map((m) => m.orderId),
        );
        await notifyTesting(db, env, shop, ids, (lang: Lang) =>
          tr(lang, row.extraEnabled ? 'testing.extraNotNeeded' : 'testing.extraOff', { shop: shop.name, product: what }),
        );
      }
    }
    return false;
  }
  const state: TestingExtraState = {
    stage: 'signup',
    until: new Date(now.getTime() + hours(Math.max(signupHours, 0))).toISOString(),
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
  // One time for giving and setting caps: it is shared out now among those who set one.
  if (signupHours === 0) {
    await shareOutExtra(db, env, shop, started, now);
    return true;
  }
  const what = await testedLabel(db, row);
  const list = missing
    .map((step, i) => `${step.tier.name}: ${formatMoney(step.missing - (missing[i - 1]?.missing ?? 0), row.currency)}`)
    .join('\n');
  // Those signed up early are in already (with their cap); the rest are invited.
  const signedIds = new Set(
    await audience(
      db,
      env,
      shop,
      early.map((m) => m.orderId),
    ),
  );
  const ids = (await giversOf(db, env, shop, row)).filter((id) => !signedIds.has(id));
  await notifyTesting(db, env, shop, ids, (lang: Lang) =>
    tr(lang, 'testing.extraOpen', {
      shop: shop.name,
      product: what,
      hours: signupHours,
      min: formatMoney(extraMin(row), row.currency),
      list,
    }),
  );
  for (const member of early) {
    const to = await audience(db, env, shop, [member.orderId]);
    await notifyTesting(db, env, shop, to, (lang: Lang) =>
      tr(lang, 'testing.extraOpenSigned', {
        shop: shop.name,
        product: what,
        hours: signupHours,
        cap: formatMoney(member.cap, row.currency),
        list,
      }),
    );
  }
  return true;
}

/**
 * Those signed up early who are still in (their order not cancelled, their
 * part paid); the others are dropped, so the share-out counts only them.
 */
async function earlyMembers(db: Database, row: TestingRow): Promise<Member[]> {
  const rows = await db
    .select({ member: testingExtraMembers, order: orders })
    .from(testingExtraMembers)
    .innerJoin(orders, eq(testingExtraMembers.orderId, orders.id))
    .where(eq(testingExtraMembers.testingId, row.id));
  const keep: Member[] = [];
  for (const { member, order } of rows) {
    if (order.status !== 'cancelled' && (await isIn(db, row, order))) keep.push(member);
    else await db.delete(testingExtraMembers).where(eq(testingExtraMembers.id, member.id));
  }
  return keep;
}

/** Whether this order is in the testing (paid its part): only those can sign up. */
async function isIn(db: Pick<Database, 'select'>, row: TestingRow, order: typeof orders.$inferSelect): Promise<boolean> {
  if (feeExempt(row, order.isVip)) return false;
  const [entry] = await db
    .select({ amount: testingEntries.amount })
    .from(testingEntries)
    .where(and(eq(testingEntries.testingId, row.id), eq(testingEntries.orderId, order.id)));
  // Something paid on the order (nothing to pay when the fee is 0 from outside).
  return entry !== undefined && takesPart(row, order.isVip, entry.amount) && (order.amountPaid > 0 || order.total <= 0);
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
  if (row.extra?.stage !== 'signup' && !preOpen(row)) {
    throw ApiError.conflict('extra_closed', 'Signing up to the extra round is over');
  }
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
  if (row.extra?.stage !== 'signup' && !preOpen(row)) {
    throw ApiError.conflict('extra_closed', 'Signing up to the extra round is over');
  }
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
  // Started, or on and not yet (signing up early while the time to join lasts).
  const live = rows.filter((r) => r.extra || preOpen(r));
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
    const extra: Omit<TestingExtraState, 'stage'> & { stage: TestingExtraView['stage'] } = row.extra ?? {
      stage: 'pre',
      until: row.donationsUntil?.toISOString() ?? '',
      target: [],
      share: 0,
    };
    const missing = await missingSteps(db, row);
    const needs = missing.map((s) => s.missing);
    const own = members.filter((m) => m.testingId === row.id);
    const mine = userId === undefined ? undefined : own.find((m) => m.userId === userId);
    const signed = own.filter((m) => m.state !== 'out');
    const early = extra.stage === 'signup' || extra.stage === 'pre';
    const estimate = early
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
      estimate: early
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
      round:
        extra.stage === 'round' && extra.gap
          ? {
              gap: extra.gap,
              options: roundOptions(
                extra.gap,
                own.filter((m) => m.state === 'paid' || m.state === 'stay' || m.state === 'left').length,
              ),
            }
          : null,
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
    await notifyTesting(db, env, shop, ids, (lang) => tr(lang, 'testing.extraNone', { shop: shop.name, product: what }));
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
        title: `Fase «Pagar» · ${what} (testing)`,
        titleEn: `«Pay» round · ${what} (testing)`,
        unitPrice: amount,
        quantity: 1,
        subtotal: amount,
        donationUnpaid: 1,
        testing: true,
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
          until: new Date(now.getTime() + hours(row.extraPayHours)).toISOString(),
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
    await notifyTesting(db, env, shop, await audience(db, env, shop, [member.orderId]), (lang) =>
      tr(lang, 'testing.extraPay', {
        shop: shop.name,
        product: what,
        tiers: names,
        amount: formatMoney(amountOf.get(member.id) ?? plan.share, row.currency),
        hours: row.extraPayHours,
      }),
    );
  }
  await notifyTesting(db, env, shop, await audience(db, env, shop, outOrders), (lang) =>
    tr(lang, 'testing.extraOut', { shop: shop.name, product: what, amount: formatMoney(plan.share, row.currency) }),
  );
}

/** Hours of the second round: to say whether one goes on, then to pay the difference. */
const ROUND_HOURS = 24;

type MemberRow = { member: Member; order: typeof orders.$inferSelect };

async function membersIn(db: Database, row: TestingRow, states: Member['state'][]): Promise<MemberRow[]> {
  return db
    .select({ member: testingExtraMembers, order: orders })
    .from(testingExtraMembers)
    .innerJoin(orders, eq(testingExtraMembers.orderId, orders.id))
    .where(and(eq(testingExtraMembers.testingId, row.id), inArray(testingExtraMembers.state, states)));
}

/** The extra round's lines on these orders (a share, and a second one when topped up). */
async function linesOf(db: Pick<Database, 'select'>, productId: string, orderIds: readonly string[]) {
  if (orderIds.length === 0) return [];
  return db
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.productId, productId), inArray(orderItems.orderId, [...orderIds])));
}

/** What the tests it is for still need on top of the pot (as it was when shared out). */
async function targetNeed(db: Database, row: TestingRow): Promise<{ need: number; collected: number }> {
  const extra = row.extra as TestingExtraState;
  const totals = (await testingTotals(db, [row.id])).get(row.id);
  const price = (await vialPrices(db, [row])).get(row.id) ?? 0;
  const pot = extra.basePot ?? 0;
  const steps = tierSteps({ tiers: row.tiers, pot, vialPrice: price, unitValue: 0 });
  const last = steps.filter((s) => extra.target.includes(s.tier.id)).pop();
  return { need: last ? Math.max(last.needed - pot, 0) : 0, collected: totals?.extraPaid ?? 0 };
}

/**
 * Paying is over: who did not pay drops out (their share comes off their
 * order). If what is paid still covers the tests, it is done; if it falls
 * short, those who paid are asked whether they go on (the second round).
 */
async function settleExtra(db: Database, env: Env, shop: ShopRow, row: TestingRow, now: Date): Promise<void> {
  if (!row.extraProductId) return;
  const productId = row.extraProductId;
  const members = await membersIn(db, row, ['in']);
  const lines = await linesOf(
    db,
    productId,
    members.map((m) => m.order.id),
  );
  const paidIds: string[] = [];
  const failed: MemberRow[] = [];
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
  const what = await testedLabel(db, row);
  if (failed.length > 0) {
    const who = failed
      .map(({ order }) => `#${order.id.slice(0, 8)}${order.contactUsername ? ` @${order.contactUsername}` : ''}`)
      .join(', ');
    await notifyShopTeam(db, env, shop, (lang) =>
      tr(lang, 'testing.extraUnpaid', { shop: shop.name, product: what, who }),
    ).catch((error: unknown) => console.error('Extra round notice failed:', error));
  }

  const { need, collected } = await targetNeed(db, row);
  if (failed.length === 0 || paidIds.length === 0 || collected >= need) {
    await finishExtra(db, env, shop, row);
    return;
  }
  // Someone did not pay: those who did say whether they go on.
  const gap = need - collected;
  await db
    .update(testings)
    .set({
      extra: {
        ...(row.extra as TestingExtraState),
        stage: 'round',
        gap,
        until: new Date(now.getTime() + hours(ROUND_HOURS)).toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(testings.id, row.id));
  const paidOrders = members.filter((m) => paidIds.includes(m.member.id)).map((m) => m.order.id);
  await notifyTesting(db, env, shop, await audience(db, env, shop, paidOrders), (lang) =>
    tr(lang, 'testing.extraRound', {
      shop: shop.name,
      product: what,
      gap: formatMoney(gap, row.currency),
      hours: ROUND_HOURS,
      options: roundOptions(gap, paidIds.length)
        .map((o) => tr(lang, 'testing.extraRoundOption', { count: o.count, amount: formatMoney(o.amount, row.currency) }))
        .join('\n'),
    }),
  );
}

/** What each would pay more, depending on how many go on. */
export function roundOptions(gap: number, people: number): Array<{ count: number; amount: number }> {
  const result: Array<{ count: number; amount: number }> = [];
  for (let count = people; count >= 1; count -= 1) result.push({ count, amount: Math.ceil(gap / count) });
  return result;
}

/** Going on or leaving, while the second round asks. */
export async function answerRound(
  db: Database,
  shop: ShopRow,
  userId: number,
  orderId: string,
  testingId: string,
  stay: boolean,
): Promise<Order> {
  const row = await db.query.testings.findFirst({ where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)) });
  if (!row) throw ApiError.notFound('Testing not found');
  if (row.extra?.stage !== 'round') throw ApiError.conflict('extra_round_closed', 'This is not the time to answer');
  const [member] = await db
    .update(testingExtraMembers)
    .set({ state: stay ? 'stay' : 'left' })
    .where(
      and(
        eq(testingExtraMembers.testingId, row.id),
        eq(testingExtraMembers.orderId, orderId),
        eq(testingExtraMembers.userId, userId),
        inArray(testingExtraMembers.state, ['paid', 'stay', 'left']),
      ),
    )
    .returning();
  if (!member) throw ApiError.conflict('extra_round_not_in', 'Only those who paid their share are asked');
  const dto = await getOrder(db, shop.id, orderId, userId);
  if (!dto) throw ApiError.notFound('Order not found');
  return dto;
}

/**
 * The second round's answers are in: those who leave (or did not answer) get
 * all they paid back; those who go on are asked the difference, in equal parts
 * within their caps. If they cannot cover it, it ends with what there is.
 */
async function endRound(db: Database, env: Env, shop: ShopRow, row: TestingRow, now: Date): Promise<void> {
  if (!row.extraProductId) return;
  const productId = row.extraProductId;
  const extra = row.extra as TestingExtraState;
  const leaving = await membersIn(db, row, ['paid', 'left']);
  await db.transaction(async (tx) => {
    for (const { member, order } of leaving) {
      await takeOff(tx, order, [productId], false);
      await tx.update(testingExtraMembers).set({ state: 'left' }).where(eq(testingExtraMembers.id, member.id));
    }
  });
  const staying = await membersIn(db, row, ['stay']);
  const { need, collected } = await targetNeed(db, row);
  const gap = Math.max(need - collected, 0);
  // Those whose cap leaves room for the difference; the rest go on with what they paid.
  let able = staying;
  let each = 0;
  for (;;) {
    if (able.length === 0) break;
    each = Math.ceil(gap / able.length);
    const next = able.filter(({ member }) => member.cap - member.share >= each);
    if (next.length === able.length) break;
    able = next;
  }
  // Those who cannot pay the difference go on with what they paid.
  const short = staying.filter((s) => !able.includes(s)).map((s) => s.member.id);
  if (gap === 0 || able.length === 0) short.push(...able.map((s) => s.member.id));
  if (short.length > 0) {
    await db.update(testingExtraMembers).set({ state: 'paid' }).where(inArray(testingExtraMembers.id, short));
  }
  if (gap === 0 || able.length === 0) {
    await finishExtra(db, env, shop, { ...row, extra: { ...extra, gap } });
    return;
  }
  // The exact difference, shared out: the cent more goes to who paid less so far.
  able.sort((x, y) => x.member.share - y.member.share);
  const base = Math.floor(gap / able.length);
  const cents = gap - base * able.length;
  const what = await testedLabel(db, row);
  const amounts = new Map(able.map((s, i) => [s.member.id, base + (i < cents ? 1 : 0)]));
  await db.transaction(async (tx) => {
    for (const { member } of able) {
      const amount = amounts.get(member.id) ?? 0;
      const [order] = await tx.select().from(orders).where(eq(orders.id, member.orderId)).for('update');
      if (!order || order.status === 'cancelled') continue;
      await tx.insert(orderItems).values({
        orderId: order.id,
        productId,
        title: `Fase «Pagar» · ${what} (testing)`,
        titleEn: `«Pay» round · ${what} (testing)`,
        unitPrice: amount,
        quantity: 1,
        subtotal: amount,
        donationUnpaid: 1,
        testing: true,
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
      await tx
        .update(testingExtraMembers)
        .set({ state: 'topup', share: member.share + amount })
        .where(eq(testingExtraMembers.id, member.id));
    }
    await tx
      .update(testings)
      .set({
        extra: { ...extra, stage: 'topup', gap, until: new Date(now.getTime() + hours(ROUND_HOURS)).toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(testings.id, row.id));
  });
  for (const { member } of able) {
    await notifyTesting(db, env, shop, await audience(db, env, shop, [member.orderId]), (lang) =>
      tr(lang, 'testing.extraTopup', {
        shop: shop.name,
        product: what,
        amount: formatMoney(amounts.get(member.id) ?? 0, row.currency),
        hours: ROUND_HOURS,
      }),
    );
  }
}

/** The difference had its time: who did not pay it leaves (all back), the rest is settled. */
async function endTopup(db: Database, env: Env, shop: ShopRow, row: TestingRow): Promise<void> {
  if (!row.extraProductId) return;
  const productId = row.extraProductId;
  const topping = await membersIn(db, row, ['topup']);
  const lines = await linesOf(
    db,
    productId,
    topping.map((m) => m.order.id),
  );
  await db.transaction(async (tx) => {
    for (const { member, order } of topping) {
      const unpaid = lines.some((l) => l.orderId === order.id && l.donationUnpaid > 0) || order.status === 'cancelled';
      if (unpaid) {
        // They said they would go on and did not: all they paid goes back, without blocking.
        await takeOff(tx, order, [productId], false);
        await tx.update(testingExtraMembers).set({ state: 'left' }).where(eq(testingExtraMembers.id, member.id));
      } else {
        await tx.update(testingExtraMembers).set({ state: 'paid' }).where(eq(testingExtraMembers.id, member.id));
      }
    }
  });
  await finishExtra(db, env, shop, row);
}

/**
 * The end: what was paid covers what it can on top of the pot as it was when
 * shared out (later gifts go to the GB). If it covers no test, everything
 * goes back to those who paid; otherwise what is left over.
 */
async function finishExtra(db: Database, env: Env, shop: ShopRow, row: TestingRow): Promise<void> {
  if (!row.extraProductId) return;
  const productId = row.extraProductId;
  const paidMembers = await membersIn(db, row, ['paid']);
  const lines = await linesOf(
    db,
    productId,
    paidMembers.map((m) => m.order.id),
  );
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
  let refunded = 0;
  if (unused > 0 && paidMembers.length > 0) {
    // In equal parts (a cent more for the first ones, when it does not divide).
    const part = Math.floor(unused / paidMembers.length);
    let rest = unused - part * paidMembers.length;
    await db.transaction(async (tx) => {
      for (const { order } of paidMembers) {
        let back = part + (rest > 0 ? 1 : 0);
        if (rest > 0) rest -= 1;
        const [fresh] = await tx.select().from(orders).where(eq(orders.id, order.id)).for('update');
        if (!fresh) continue;
        let lowered = 0;
        for (const line of lines.filter((l) => l.orderId === order.id)) {
          if (back <= 0) break;
          const cut = Math.min(back, line.unitPrice);
          const left = line.unitPrice - cut;
          if (left === 0) await tx.delete(orderItems).where(eq(orderItems.id, line.id));
          else await tx.update(orderItems).set({ unitPrice: left, subtotal: left }).where(eq(orderItems.id, line.id));
          back -= cut;
          lowered += cut;
        }
        // Paid already: lowering the total leaves it owed back (the usual refund).
        await tx
          .update(orders)
          .set({ total: fresh.total - lowered, updatedAt: new Date() })
          .where(eq(orders.id, fresh.id));
        refunded += lowered;
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
  await notifyTesting(
    db,
    env,
    shop,
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
    await notifyTesting(db, env, shop, await audience(db, env, shop, [u.id]), (lang) =>
      tr(lang, 'testing.extraRemind', { shop: shop.name, product: what, amount: formatMoney(u.share, row.currency) }),
    );
  }
}

/** Every minute: moves each extra round along (sign-up → shares → paying → done). */
export async function advanceExtras(db: Database, env: Env, now = new Date()): Promise<void> {
  const rows = await db
    .select()
    .from(testings)
    .where(and(eq(testings.status, 'closed'), sql`${testings.extra}->>'stage' in ('signup', 'pay', 'round', 'topup')`));
  for (const row of rows) {
    const extra = row.extra as TestingExtraState;
    const shop = await db.query.shops.findFirst({ where: (s, { eq: same }) => same(s.id, row.shopId) });
    if (!shop) continue;
    const until = new Date(extra.until);
    try {
      if (extra.stage === 'signup' && until <= now) {
        await shareOutExtra(db, env, shop, row, now);
      } else if (extra.stage === 'pay' && until <= now) {
        await settleExtra(db, env, shop, row, now);
      } else if (extra.stage === 'round' && until <= now) {
        await endRound(db, env, shop, row, now);
      } else if (extra.stage === 'topup' && until <= now) {
        await endTopup(db, env, shop, row);
      } else if (extra.stage === 'pay' && !extra.reminded && until.getTime() - now.getTime() <= hours(row.extraPayHours / 2)) {
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
  if (!row.extra) {
    // Not started: only those signed up early go.
    await tx.delete(testingExtraMembers).where(eq(testingExtraMembers.testingId, row.id));
    return;
  }
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

/** What was tested in the extra rounds whose share this order did not pay (for the team). */
export async function unpaidExtras(db: Database, orderId: string): Promise<string[]> {
  const rows = await db
    .select({ testing: testings })
    .from(testingExtraMembers)
    .innerJoin(testings, eq(testingExtraMembers.testingId, testings.id))
    .where(and(eq(testingExtraMembers.orderId, orderId), eq(testingExtraMembers.state, 'failed')));
  const labels: string[] = [];
  for (const { testing } of rows) labels.push(await testedLabel(db, testing));
  return labels;
}
