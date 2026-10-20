import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { RetentionReport, RetentionSettings, RetentionStatus } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { carts, orders, platformSettings, users } from '../db/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RETENTION: RetentionSettings = {
  addressRetentionDays: 30,
  cartRetentionDays: 30,
  inactiveUserDays: 30,
};

type SettingsRow = typeof platformSettings.$inferSelect;

async function loadRow(db: Database): Promise<SettingsRow | undefined> {
  return db.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1) });
}

export async function getRetention(db: Database): Promise<RetentionStatus> {
  const row = await loadRow(db);
  return {
    addressRetentionDays: row?.addressRetentionDays ?? DEFAULT_RETENTION.addressRetentionDays,
    cartRetentionDays: row?.cartRetentionDays ?? DEFAULT_RETENTION.cartRetentionDays,
    inactiveUserDays: row?.inactiveUserDays ?? DEFAULT_RETENTION.inactiveUserDays,
    lastRunAt: row?.lastRetentionRunAt?.toISOString() ?? null,
  };
}

export async function updateRetention(
  db: Database,
  settings: RetentionSettings,
): Promise<RetentionStatus> {
  await db
    .insert(platformSettings)
    .values({ id: 1, ...settings, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { ...settings, updatedAt: new Date() },
    });
  return getRetention(db);
}

/**
 * Applies the retention policy:
 *  1. Orders closed (delivered or cancelled) longer than `addressRetentionDays`
 *     lose their encrypted address and their link to the customer; products,
 *     amounts, payments and the contact @username stay for the records.
 *     Orders that still owe the customer a refund are kept as they are.
 *  2. Carts untouched for `cartRetentionDays` are deleted.
 *  3. Users who have not opened the app for `inactiveUserDays` and have no
 *     orders linked to them are deleted — except GB admins, owners and
 *     organisers, whose names are shown under "Organised by".
 */
export async function runRetention(db: Database, now = new Date()): Promise<RetentionReport> {
  const settings = await getRetention(db);
  const before = (days: number): Date => new Date(now.getTime() - days * DAY_MS);

  const anonymized = await db
    .update(orders)
    .set({
      userId: null,
      encryptedAddress: null,
      addressKeyFingerprint: null,
      anonymizedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        isNull(orders.anonymizedAt),
        isNotNull(orders.closedAt),
        lt(orders.closedAt, before(settings.addressRetentionDays)),
        sql`${orders.status} IN ('fulfilled', 'cancelled')`,
        // Nothing left to give back to the customer.
        sql`${orders.amountPaid} <= CASE WHEN ${orders.status} = 'cancelled' THEN 0 ELSE ${orders.total} END`,
      ),
    )
    .returning({ id: orders.id });

  const cartsDeleted = await db
    .delete(carts)
    .where(lt(carts.updatedAt, before(settings.cartRetentionDays)))
    .returning({ id: carts.id });

  const usersDeleted = await db
    .delete(users)
    .where(
      and(
        lt(users.lastSeenAt, before(settings.inactiveUserDays)),
        sql`NOT EXISTS (SELECT 1 FROM "orders" o WHERE o."user_id" = ${users.telegramId})`,
        sql`NOT EXISTS (SELECT 1 FROM "shops" s WHERE s."admin_ids" @> to_jsonb(${users.telegramId}) OR s."owner_ids" @> to_jsonb(${users.telegramId}))`,
        sql`NOT EXISTS (SELECT 1 FROM "platform_settings" p WHERE p."organizer_ids" @> to_jsonb(${users.telegramId}))`,
      ),
    )
    .returning({ id: users.telegramId });

  await db
    .insert(platformSettings)
    .values({ id: 1, lastRetentionRunAt: now })
    .onConflictDoUpdate({ target: platformSettings.id, set: { lastRetentionRunAt: now } });

  return {
    ordersAnonymized: anonymized.length,
    cartsDeleted: cartsDeleted.length,
    usersDeleted: usersDeleted.length,
    ranAt: now.toISOString(),
  };
}
