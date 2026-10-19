import { eq, inArray, sql } from 'drizzle-orm';
import {
  splitPersonRefs,
  type OrganizerTag,
  type OrganizersView,
  type Person,
  type ShopTeam,
} from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { platformSettings, shops, users } from '../db/schema.js';
import { tr, type BotMessageKey } from '../i18n/messages.js';
import { notifyUsers } from './notifications.js';
import type { ShopRow } from './shop.js';

/**
 * Who runs what:
 *  - super-admins (ADMIN_TELEGRAM_IDS): everything;
 *  - organisers (listed in Platform): may create GBs (new or from a backup);
 *  - administrators of a GB (`ownerIds`, one or more): also its team,
 *    payments, address key, visibility, copies, backup and deleting it;
 *  - managers of a GB (`adminIds`): run that GB day to day (catalog, orders,
 *    settings).
 */

export type PersonInfo = { username: string | null; firstName: string };

/** Names of the given users, for those who have opened the app. */
export async function loadPeople(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, PersonInfo>> {
  const result = new Map<number, PersonInfo>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return result;
  const rows = await db
    .select({ id: users.telegramId, username: users.username, firstName: users.firstName })
    .from(users)
    .where(inArray(users.telegramId, unique));
  for (const row of rows) result.set(row.id, { username: row.username, firstName: row.firstName });
  return result;
}

function toPerson(id: number, people: Map<number, PersonInfo>): Person {
  const info = people.get(id);
  return { telegramId: id, username: info?.username ?? null, firstName: info?.firstName ?? null };
}

/** "Organised by": the GB's team that has opened the app, administrators first. */
export function organizerTags(shop: ShopRow, people: Map<number, PersonInfo>): OrganizerTag[] {
  const tags: OrganizerTag[] = [];
  for (const id of [...new Set([...shop.ownerIds, ...shop.adminIds])]) {
    const info = people.get(id);
    if (info) tags.push({ username: info.username, name: info.firstName });
  }
  return tags;
}

/**
 * Turns typed ids and @usernames into ids. @usernames of people who already
 * opened the app become their id now; the rest stay pending.
 */
export async function resolvePeople(
  db: Database,
  refs: readonly string[],
): Promise<{ ids: number[]; pending: string[] }> {
  const { usernames } = splitPersonRefs(refs);
  const known = new Map<string, number>();
  if (usernames.length > 0) {
    const rows = await db
      .select({ id: users.telegramId, username: users.username })
      .from(users)
      .where(inArray(sql<string>`lower(${users.username})`, usernames));
    for (const row of rows) if (row.username) known.set(row.username.toLowerCase(), row.id);
  }
  // In the order typed: it is the order shown under "Organised by".
  const ids: number[] = [];
  const pending: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (/^\d{1,15}$/.test(ref)) {
      const id = Number(ref);
      if (id > 0 && !ids.includes(id)) ids.push(id);
      continue;
    }
    const name = ref.replace(/^@/, '').toLowerCase();
    if (!name) continue;
    const id = known.get(name);
    if (id === undefined) {
      if (!pending.includes(name)) pending.push(name);
    } else if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return { ids, pending };
}

/** Who runs a GB, with names. */
export async function getShopTeam(db: Database, shop: ShopRow): Promise<ShopTeam> {
  const people = await loadPeople(db, [...shop.ownerIds, ...shop.adminIds]);
  return {
    owners: shop.ownerIds.map((id) => toPerson(id, people)),
    admins: shop.adminIds.map((id) => toPerson(id, people)),
    pendingOwnerUsernames: shop.ownerUsernames,
    pendingUsernames: shop.adminUsernames,
  };
}

// --- Organisers ----------------------------------------------------------------

async function platformRow(db: Database) {
  return db.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1) });
}

export async function isOrganizer(db: Database, userId: number | undefined): Promise<boolean> {
  if (userId === undefined) return false;
  const row = await platformRow(db);
  return row?.organizerIds.includes(userId) ?? false;
}

/** How many GBs each user is an administrator of. */
async function ownedShops(db: Database): Promise<Map<number, number>> {
  const rows = await db.select({ ownerIds: shops.ownerIds }).from(shops);
  const counts = new Map<number, number>();
  for (const row of rows) for (const id of row.ownerIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

export async function getOrganizers(db: Database): Promise<OrganizersView> {
  const row = await platformRow(db);
  const ids = row?.organizerIds ?? [];
  const [people, owned] = await Promise.all([loadPeople(db, ids), ownedShops(db)]);
  return {
    organizers: ids.map((id) => ({ ...toPerson(id, people), ownedShops: owned.get(id) ?? 0 })),
    pendingUsernames: row?.organizerUsernames ?? [],
  };
}

/**
 * Replaces the organisers. With `releaseShops`, those taken off the list also
 * stop being administrators of their GBs.
 */
export async function updateOrganizers(
  db: Database,
  refs: readonly string[],
  releaseShops = false,
): Promise<OrganizersView> {
  const before = (await platformRow(db))?.organizerIds ?? [];
  const { ids, pending } = await resolvePeople(db, refs);
  const values = { organizerIds: ids, organizerUsernames: pending, updatedAt: new Date() };
  await db
    .insert(platformSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: platformSettings.id, set: values });
  const removed = before.filter((id) => !ids.includes(id));
  if (releaseShops && removed.length > 0) {
    const rows = await db.select({ id: shops.id, ownerIds: shops.ownerIds }).from(shops);
    for (const row of rows) {
      if (!row.ownerIds.some((id) => removed.includes(id))) continue;
      await db
        .update(shops)
        .set({ ownerIds: row.ownerIds.filter((id) => !removed.includes(id)) })
        .where(eq(shops.id, row.id));
    }
  }
  return getOrganizers(db);
}

/**
 * On sign-in: someone added by @username to a GB's admins or to the
 * organisers gets the role for good, under their id.
 */
export async function claimPendingRoles(
  db: Database,
  userId: number,
  username: string | null,
): Promise<void> {
  if (!username) return;
  const name = username.toLowerCase();
  const asJson = JSON.stringify([name]);
  const add = (ids: number[]): number[] => (ids.includes(userId) ? ids : [...ids, userId]);
  const pendingShops = await db
    .select({
      id: shops.id,
      adminIds: shops.adminIds,
      adminUsernames: shops.adminUsernames,
      ownerIds: shops.ownerIds,
      ownerUsernames: shops.ownerUsernames,
    })
    .from(shops)
    .where(
      sql`${shops.adminUsernames} @> ${asJson}::jsonb OR ${shops.ownerUsernames} @> ${asJson}::jsonb`,
    );
  for (const shop of pendingShops) {
    const owner = shop.ownerUsernames.includes(name);
    await db
      .update(shops)
      .set({
        adminUsernames: shop.adminUsernames.filter((u) => u !== name),
        ownerUsernames: shop.ownerUsernames.filter((u) => u !== name),
        ...(owner
          ? { ownerIds: add(shop.ownerIds), adminIds: shop.adminIds.filter((id) => id !== userId) }
          : { adminIds: shop.ownerIds.includes(userId) ? shop.adminIds : add(shop.adminIds) }),
      })
      .where(eq(shops.id, shop.id));
  }
  const platform = await platformRow(db);
  if (platform?.organizerUsernames.includes(name)) {
    await db
      .update(platformSettings)
      .set({
        organizerUsernames: platform.organizerUsernames.filter((u) => u !== name),
        organizerIds: platform.organizerIds.includes(userId)
          ? platform.organizerIds
          : [...platform.organizerIds, userId],
      })
      .where(eq(platformSettings.id, 1));
  }
}

/**
 * Administrator powers over a GB (team, payments, address key, visibility,
 * duplicating, backup, deleting it): its administrators and the super-admins.
 * Being an organiser only lets someone create GBs.
 */
export function canOwnShop(env: Env, shop: ShopRow, userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return env.ADMIN_TELEGRAM_IDS.includes(userId) || shop.ownerIds.includes(userId);
}

/** "@ana" or "Ana (123)": how a user is named in messages to super-admins. */
export async function describeUser(db: Database, userId: number): Promise<string> {
  const info = (await loadPeople(db, [userId])).get(userId);
  if (info?.username) return `@${info.username}`;
  return info ? `${info.firstName} (${userId})` : String(userId);
}

/** Tells the super-admins what an organiser did (not when they did it themselves). */
export async function notifySuperAdmins(
  db: Database,
  env: Env,
  actorId: number,
  key: Extract<BotMessageKey, 'platform.gbCreated' | 'platform.gbDeleted'>,
  vars: Record<string, string | number>,
): Promise<void> {
  if (env.ADMIN_TELEGRAM_IDS.includes(actorId)) return;
  const who = await describeUser(db, actorId);
  await notifyUsers(db, env.BOT_TOKEN, [...env.ADMIN_TELEGRAM_IDS], (lang) =>
    tr(lang, key, { who, ...vars }),
  );
}
