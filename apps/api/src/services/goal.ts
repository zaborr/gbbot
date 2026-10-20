import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { isSaleStatus, type GoalProgress, type Lang, type OrderStatus } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, shops } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { notifyUsers } from './notifications.js';
import type { ShopRow } from './shop.js';

/**
 * A GB's minimum: what its orders add up to (products only, cancelled ones
 * left out), split into paid and still to pay. Currencies are added up as
 * they are (a GB sells in one of them).
 */
export interface GoalTotals {
  paid: number;
  pending: number;
}

/** Totals of the given GBs, in one query. */
export async function goalTotals(
  db: Database,
  shopIds: readonly string[],
): Promise<Map<string, GoalTotals>> {
  const result = new Map<string, GoalTotals>();
  if (shopIds.length === 0) return result;
  const rows = await db
    .select({
      shopId: orders.shopId,
      status: orders.status,
      amount: sql<number>`coalesce(sum(${orderItems.subtotal}), 0)::bigint`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(inArray(orders.shopId, [...shopIds]), ne(orders.status, 'cancelled')))
    .groupBy(orders.shopId, orders.status);
  for (const row of rows) {
    const totals = result.get(row.shopId) ?? { paid: 0, pending: 0 };
    if (isSaleStatus(row.status as OrderStatus)) totals.paid += Number(row.amount);
    else totals.pending += Number(row.amount);
    result.set(row.shopId, totals);
  }
  return result;
}

const percent = (part: number, whole: number): number => Math.floor((part * 100) / whole);

/** What the app shows: amounts for the team, or when the GB shows them. */
export function goalProgressOf(
  shop: ShopRow,
  totals: GoalTotals | undefined,
  showAll: boolean,
): GoalProgress | null {
  const target = shop.goalAmount;
  if (!target) return null;
  const paid = totals?.paid ?? 0;
  const ordered = paid + (totals?.pending ?? 0);
  const amounts = showAll || shop.goalShowAmount;
  return {
    target: amounts ? target : null,
    paid: amounts ? paid : null,
    ordered: amounts ? ordered : null,
    paidPercent: percent(paid, target),
    orderedPercent: percent(ordered, target),
    reached: paid >= target,
    currency: shop.currency,
  };
}

export async function loadGoalProgress(
  db: Database,
  shop: ShopRow,
  showAll: boolean,
): Promise<GoalProgress | null> {
  if (!shop.goalAmount) return null;
  return goalProgressOf(shop, (await goalTotals(db, [shop.id])).get(shop.id), showAll);
}

/** Sets (or with null removes) the minimum; with a new amount, milestones start again. */
export async function updateGoal(
  db: Database,
  shopId: string,
  amount: number | null,
  showAmount: boolean,
): Promise<ShopRow> {
  const [row] = await db
    .update(shops)
    .set({
      goalAmount: amount,
      goalShowAmount: showAmount,
      goalNotified: sql`CASE WHEN ${shops.goalAmount} IS DISTINCT FROM ${amount}::integer THEN 0 ELSE ${shops.goalNotified} END`,
    })
    .where(eq(shops.id, shopId))
    .returning();
  if (!row) throw new Error('Shop not found');
  return row;
}

const MILESTONES = [50, 80, 100] as const;

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/**
 * After a payment is confirmed: when the paid orders pass 50 %, 80 % or the
 * minimum, everyone with an order in the GB hears it (each milestone once).
 */
export async function announceGoalMilestones(db: Database, env: Env, shopId: string): Promise<void> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop?.goalAmount) return;
  const totals = (await goalTotals(db, [shop.id])).get(shop.id);
  const paid = totals?.paid ?? 0;
  const reachedPercent = percent(paid, shop.goalAmount);
  const milestone = [...MILESTONES].reverse().find((m) => reachedPercent >= m);
  if (!milestone || milestone <= shop.goalNotified) return;

  // Claim it first, so two payments at once do not announce it twice.
  const claimed = await db
    .update(shops)
    .set({ goalNotified: milestone })
    .where(and(eq(shops.id, shop.id), sql`${shops.goalNotified} < ${milestone}`))
    .returning({ id: shops.id });
  if (claimed.length === 0) return;

  const buyers = await db
    .selectDistinct({ userId: orders.userId })
    .from(orders)
    .where(and(eq(orders.shopId, shop.id), ne(orders.status, 'cancelled')));
  const ids = buyers.flatMap((b) => (b.userId === null ? [] : [b.userId]));
  const vars = {
    shop: shop.name,
    percent: reachedPercent,
    paid: money(paid, shop.currency),
    target: money(shop.goalAmount, shop.currency),
    missing: money(Math.max(shop.goalAmount - paid, 0), shop.currency),
  };
  const text = (lang: Lang): string =>
    milestone === 100
      ? tr(lang, shop.goalShowAmount ? 'goal.reachedAmount' : 'goal.reached', vars)
      : tr(lang, shop.goalShowAmount ? 'goal.progressAmount' : 'goal.progress', vars);
  await notifyUsers(db, env.BOT_TOKEN, ids, text);
}

/** Text for the team when a GB closes on its date without its minimum. */
export function missedGoalText(lang: Lang, shop: ShopRow, paid: number): string {
  const target = shop.goalAmount ?? 0;
  return tr(lang, 'goal.missed', {
    shop: shop.name,
    paid: money(paid, shop.currency),
    target: money(target, shop.currency),
    percent: target > 0 ? percent(paid, target) : 0,
  });
}
