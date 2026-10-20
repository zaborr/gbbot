import { and, eq, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orders, shops } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { buildStatusMessage, languagesOf, notifyChats } from './notifications.js';
import { tr } from '../i18n/messages.js';
import { changeOrderStatus } from './orders.js';

/**
 * Cancels unpaid orders that went `autoCancelHours` (per shop) without any
 * activity. Only plain unpaid orders: nothing paid and no payment waiting for
 * review. The customer gets a message from the bot. Returns how many.
 */
export async function cancelExpiredOrders(db: Database, env: Env): Promise<number> {
  const expired = await db
    .select({
      id: orders.id,
      shopId: orders.shopId,
      userId: orders.userId,
      shopName: shops.name,
      hours: shops.autoCancelHours,
    })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(
      and(
        eq(orders.status, 'pending'),
        eq(orders.amountPaid, 0),
        eq(orders.amountSubmitted, 0),
        sql`${shops.autoCancelHours} > 0`,
        sql`${orders.updatedAt} < now() - make_interval(hours => ${shops.autoCancelHours})`,
      ),
    );

  const langs = await languagesOf(
    db,
    expired.flatMap((row) => (row.userId === null ? [] : [row.userId])),
  );
  let cancelled = 0;
  for (const row of expired) {
    // The note is kept on the order, so it is written in the customer's language.
    const lang = (row.userId !== null ? langs.get(row.userId) : undefined) ?? 'en';
    try {
      const { order } = await changeOrderStatus(db, row.shopId, row.id, {
        status: 'cancelled',
        note: tr(lang, 'autoCancel.note', { hours: row.hours }),
      });
      cancelled += 1;
      if (order.userId !== null) {
        await notifyChats(
          env.BOT_TOKEN,
          [order.userId],
          buildStatusMessage(lang, row.shopName, order, 'pending'),
        );
      }
    } catch (error) {
      // Changed meanwhile (e.g. the customer just paid): leave it alone.
      if (!(error instanceof ApiError)) console.error(`Could not auto-cancel order ${row.id}:`, error);
    }
  }
  return cancelled;
}
