import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orders, shops } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { TelegramApi } from '../telegram/api.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { withoutBlockedIn } from './blacklist.js';

/** Without automatic cancellation, the reminder goes out after this long. */
export const DEFAULT_REMINDER_HOURS = 24;

/** The Mini App URL that opens straight on an order (read by the app at launch). */
export function orderLink(appUrl: string, shopSlug: string, orderId: string): string {
  const url = new URL(appUrl);
  url.searchParams.set('shop', shopSlug);
  url.searchParams.set('order', orderId);
  url.hash = '';
  return url.toString();
}

/** The Mini App URL that opens straight on a GB (read by the app at launch). */
export function shopLink(appUrl: string, shopSlug: string): string {
  const url = new URL(appUrl);
  url.searchParams.set('shop', shopSlug);
  url.hash = '';
  return url.toString();
}

/** Hours until an unpaid order is cancelled automatically, or null if it never is. */
export function hoursLeft(
  order: { amountPaid: number; updatedAt: Date },
  autoCancelHours: number,
  now: Date,
): number | null {
  if (autoCancelHours <= 0 || order.amountPaid > 0) return null;
  const elapsed = (now.getTime() - order.updatedAt.getTime()) / 3_600_000;
  return Math.max(1, Math.round(autoCancelHours - elapsed));
}

/**
 * Reminds customers, once per order, that they still have to pay: halfway to
 * the shop's automatic cancellation, or after a day when the shop does not
 * cancel (and for differences left after a change). The message has a button
 * that opens the app on the order. Returns how many reminders were sent.
 */
export async function sendPaymentReminders(
  db: Database,
  env: Env,
  telegram = new TelegramApi(env.BOT_TOKEN),
  now = new Date(),
): Promise<number> {
  const due = await db
    .select({
      id: orders.id,
      shopId: orders.shopId,
      userId: orders.userId,
      total: orders.total,
      amountPaid: orders.amountPaid,
      currency: orders.currency,
      updatedAt: orders.updatedAt,
      shopName: shops.name,
      shopSlug: shops.slug,
      autoCancelHours: shops.autoCancelHours,
    })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(
      and(
        eq(orders.status, 'pending'),
        eq(orders.amountSubmitted, 0),
        sql`${orders.total} - ${orders.amountPaid} > 0`,
        isNotNull(orders.userId),
        isNull(orders.paymentReminderAt),
        // Closed GBs drop their unpaid orders instead.
        isNull(shops.closedAt),
        sql`(${shops.closesAt} IS NULL OR ${shops.closesAt} > now())`,
        sql`${orders.updatedAt} < now() - (CASE WHEN ${shops.autoCancelHours} > 0 AND ${orders.amountPaid} = 0 THEN ${shops.autoCancelHours} / 2.0 ELSE ${DEFAULT_REMINDER_HOURS} END) * interval '1 hour'`,
      ),
    );
  if (due.length === 0) return 0;

  const appUrl = await miniAppUrl(telegram);
  const langs = await languagesOf(
    db,
    due.flatMap((row) => (row.userId === null ? [] : [row.userId])),
  );
  let sent = 0;
  for (const row of due) {
    if (row.userId === null) continue;
    // The blacklisted hear nothing from the GB (the order may stay pending).
    if ((await withoutBlockedIn(db, env, row.shopId, [row.userId])).length === 0) continue;
    // Claim it first, so a reminder is never sent twice. `updated_at` is left
    // alone: it measures the customer's inactivity for the auto-cancel.
    const [claimed] = await db
      .update(orders)
      .set({ paymentReminderAt: now })
      .where(and(eq(orders.id, row.id), isNull(orders.paymentReminderAt)))
      .returning({ id: orders.id });
    if (!claimed) continue;

    const lang = langs.get(row.userId) ?? 'en';
    const amount = `${((row.total - row.amountPaid) / 100).toFixed(2)} ${row.currency}`;
    const ref = tr(lang, 'order.ref', { shop: row.shopName, id: row.id.slice(0, 8) });
    const lines = [tr(lang, 'reminder.unpaid', { ref, amount })];
    const left = hoursLeft(row, row.autoCancelHours, now);
    if (left !== null) lines.push(tr(lang, 'reminder.cancelIn', { hours: left }));
    if (!appUrl) lines.push('', tr(lang, 'reminder.openShop'));
    try {
      await telegram.sendMessage(
        row.userId,
        lines.join('\n'),
        appUrl
          ? {
              inline_keyboard: [
                [
                  {
                    text: tr(lang, 'reminder.pay'),
                    web_app: { url: orderLink(appUrl, row.shopSlug, row.id) },
                  },
                ],
              ],
            }
          : undefined,
      );
      sent++;
    } catch (error) {
      // They blocked the bot or never started it: nothing else to do.
      console.warn(`Could not remind order ${row.id}:`, error instanceof Error ? error.message : error);
    }
  }
  return sent;
}
