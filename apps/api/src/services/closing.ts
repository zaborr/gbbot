import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { isClosedAt, type ClosePreview } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { carts, orders, shops } from '../db/schema.js';
import { toOrderDTO } from '../db/mappers.js';
import { ApiError } from '../lib/errors.js';
import { buildChangeDecisionMessage, notifyUsers } from './notifications.js';
import { shopNotificationChatIds, type ShopRow } from './shop.js';
import { goalTotals, missedGoalText } from './goal.js';

/** Refuses anything that would create or grow an order in a closed GB. */
export function assertOpen(shop: ShopRow, now = new Date()): void {
  if (isClosedAt(shop, now)) {
    throw ApiError.conflict('gb_closed', 'This GB is closed: it no longer takes orders');
  }
}

/** Orders with nothing paid and nothing sent for review. */
const unpaidOrders = (shopId: string) =>
  and(
    eq(orders.shopId, shopId),
    eq(orders.status, 'pending'),
    eq(orders.amountPaid, 0),
    eq(orders.amountSubmitted, 0),
  );

export async function closePreview(db: Database, shopId: string): Promise<ClosePreview> {
  const count = async (where: ReturnType<typeof and>): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(where);
    return Number(row?.n ?? 0);
  };
  const [unpaid, changes, toReview, cartRows] = await Promise.all([
    count(unpaidOrders(shopId)),
    count(and(eq(orders.shopId, shopId), isNotNull(orders.changeRequest))),
    count(and(eq(orders.shopId, shopId), eq(orders.status, 'awaiting_payment'))),
    db.select({ n: sql<number>`count(*)::int` }).from(carts).where(eq(carts.shopId, shopId)),
  ]);
  return {
    unpaidOrders: unpaid,
    carts: Number(cartRows[0]?.n ?? 0),
    pendingChanges: changes,
    paymentsToReview: toReview,
  };
}

/**
 * What closing does (also run again on closed GBs by the maintenance, to catch
 * orders that became unpaid later, e.g. a rejected payment):
 * deletes unpaid orders and the carts, and rejects pending change requests
 * (the customer is told). Paid orders, payments under review and differences
 * still to pay stay.
 */
async function cleanUpClosed(db: Database, env: Env, shop: ShopRow): Promise<void> {
  await db.delete(orders).where(unpaidOrders(shop.id));
  await db.delete(carts).where(eq(carts.shopId, shop.id));
  const rejected = await db
    .update(orders)
    .set({ changeRequest: null, updatedAt: new Date() })
    .where(and(eq(orders.shopId, shop.id), isNotNull(orders.changeRequest)))
    .returning();
  for (const row of rejected) {
    if (row.userId === null) continue;
    const order = toOrderDTO(row, []);
    await notifyUsers(db, env.BOT_TOKEN, [row.userId], (lang) =>
      buildChangeDecisionMessage(lang, order, false),
    );
  }
}

/** Closes the GB now. */
export async function closeShop(db: Database, env: Env, shop: ShopRow): Promise<ShopRow> {
  const [row] = await db
    .update(shops)
    .set({ closedAt: new Date(), closesAt: null })
    .where(eq(shops.id, shop.id))
    .returning();
  if (!row) throw ApiError.notFound('Shop not found');
  await cleanUpClosed(db, env, row);
  return row;
}

/** Opens a closed GB again (deleted orders do not come back). */
export async function reopenShop(db: Database, shop: ShopRow): Promise<ShopRow> {
  const [row] = await db
    .update(shops)
    .set({ closedAt: null, closesAt: null })
    .where(eq(shops.id, shop.id))
    .returning();
  if (!row) throw ApiError.notFound('Shop not found');
  return row;
}

/** Schedules (or with null cancels) the closing of an open GB. */
export async function scheduleClosing(
  db: Database,
  shop: ShopRow,
  closesAt: Date | null,
  warnHours?: number,
): Promise<ShopRow> {
  if (shop.closedAt) throw ApiError.conflict('gb_closed', 'This GB is closed: it no longer takes orders');
  if (closesAt && closesAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('closing_in_past', 'The closing date must be in the future');
  }
  const [row] = await db
    .update(shops)
    .set({ closesAt, closingWarnHours: warnHours ?? shop.closingWarnHours })
    .where(eq(shops.id, shop.id))
    .returning();
  if (!row) throw ApiError.notFound('Shop not found');
  return row;
}

/**
 * Maintenance: GBs whose scheduled closing has passed are closed for good,
 * and every closed GB is cleaned up again. Returns how many were closed now.
 */
export async function closeDueShops(db: Database, env: Env, now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(shops)
    .where(or(isNotNull(shops.closedAt), and(isNull(shops.closedAt), lte(shops.closesAt, now))));
  let closed = 0;
  for (const shop of due) {
    let row = shop;
    if (!shop.closedAt) {
      const [updated] = await db
        .update(shops)
        .set({ closedAt: shop.closesAt ?? now, closesAt: null })
        .where(eq(shops.id, shop.id))
        .returning();
      if (updated) row = updated;
      closed++;
      // Closed on its date without its minimum: the team decides what to do.
      if (row.goalAmount) {
        const paid = (await goalTotals(db, [row.id])).get(row.id)?.paid ?? 0;
        if (paid < row.goalAmount) {
          const shopRow = row;
          await notifyUsers(db, env.BOT_TOKEN, shopNotificationChatIds(env, row), (lang) =>
            missedGoalText(lang, shopRow, paid),
          ).catch((error: unknown) => console.error('Missed goal notice failed:', error));
        }
      }
    }
    try {
      await cleanUpClosed(db, env, row);
    } catch (error) {
      console.error(`Could not clean up closed GB ${shop.id}:`, error);
    }
  }
  return closed;
}
