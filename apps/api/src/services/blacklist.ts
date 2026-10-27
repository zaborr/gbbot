import { and, eq, sql } from 'drizzle-orm';
import {
  isSaleStatus,
  type Blacklist,
  type BlacklistCheck,
  type BlacklistView,
  type OrderStatus,
} from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { cartItems, carts, orders, platformSettings, shops } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { deleteOrder } from './orders.js';
import { canManageShop, isSuperAdmin, type ShopRow } from './shop.js';
import { describeUser, loadPeople, resolvePeople } from './team.js';

/*
 * Blacklists: for the people in them the GB (or, in the platform one, every
 * GB) does not exist — not in the list, not by link, no messages from it. The
 * GB's team and the platform admins are never affected.
 */

const EMPTY: Blacklist = { userIds: [], usernames: [] };

function normalize(list: Blacklist | null | undefined): Blacklist {
  return { userIds: list?.userIds ?? [], usernames: list?.usernames ?? [] };
}

let platformCache: { list: Blacklist; until: number } | null = null;

export async function getPlatformBlacklist(db: Database): Promise<Blacklist> {
  if (platformCache && platformCache.until > Date.now()) return platformCache.list;
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1) });
  const list = normalize(row?.blacklist ?? EMPTY);
  platformCache = { list, until: Date.now() + 10_000 };
  return list;
}

async function savePlatformBlacklist(db: Database, list: Blacklist): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ id: 1, blacklist: list, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.id, set: { blacklist: list, updatedAt: new Date() } });
  platformCache = null;
}

/** Whether the GB does not exist for this user (team and platform admins: never). */
export async function isBlocked(
  db: Database,
  env: Env,
  shop: ShopRow,
  userId: number,
): Promise<boolean> {
  if (canManageShop(env, shop, userId)) return false;
  if (normalize(shop.blacklist).userIds.includes(userId)) return true;
  return (await getPlatformBlacklist(db)).userIds.includes(userId);
}

/** The given users without those the GB does not exist for (messages from it). */
export async function withoutBlocked(
  db: Database,
  env: Env,
  shop: ShopRow,
  ids: readonly number[],
): Promise<number[]> {
  const platform = await getPlatformBlacklist(db);
  const own = normalize(shop.blacklist);
  return ids.filter(
    (id) =>
      canManageShop(env, shop, id) || (!own.userIds.includes(id) && !platform.userIds.includes(id)),
  );
}

/** Same, when only the GB's id is at hand. */
export async function withoutBlockedIn(
  db: Database,
  env: Env,
  shopId: string,
  ids: readonly number[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  return shop ? withoutBlocked(db, env, shop, ids) : [...ids];
}

/** Added by @username: once they open the app, the entry becomes their id. */
export async function claimBlacklisted(
  db: Database,
  userId: number,
  username: string | null,
): Promise<void> {
  if (!username) return;
  const name = username.toLowerCase();
  const claim = (list: Blacklist): Blacklist => ({
    usernames: list.usernames.filter((u) => u !== name),
    userIds: list.userIds.includes(userId) ? list.userIds : [...list.userIds, userId],
  });
  const pending = await db
    .select({ id: shops.id, blacklist: shops.blacklist })
    .from(shops)
    .where(sql`${shops.blacklist}->'usernames' @> ${JSON.stringify([name])}::jsonb`);
  for (const row of pending) {
    await db
      .update(shops)
      .set({ blacklist: claim(normalize(row.blacklist)) })
      .where(eq(shops.id, row.id));
  }
  const platform = await getPlatformBlacklist(db);
  if (platform.usernames.includes(name)) await savePlatformBlacklist(db, claim(platform));
}

async function view(db: Database, list: Blacklist): Promise<BlacklistView> {
  const people = await loadPeople(db, list.userIds);
  return {
    people: list.userIds.map((id) => ({
      telegramId: id,
      username: people.get(id)?.username ?? null,
      firstName: people.get(id)?.firstName ?? null,
    })),
    pendingUsernames: list.usernames,
  };
}

export const shopBlacklistView = (db: Database, shop: ShopRow): Promise<BlacklistView> =>
  view(db, normalize(shop.blacklist));
export const platformBlacklistView = async (db: Database): Promise<BlacklistView> =>
  view(db, await getPlatformBlacklist(db));

/** "@ana", "ana" or an id → their id when known, else the pending @username. */
async function resolveWho(
  db: Database,
  who: string,
): Promise<{ id: number | null; username: string | null }> {
  const { ids, pending } = await resolvePeople(db, [who]);
  const id = ids[0];
  if (id !== undefined) return { id, username: null };
  const username = pending[0];
  if (!username || !/^[a-z0-9_]{3,32}$/.test(username)) {
    throw ApiError.badRequest('bad_person', 'Write a @username or a Telegram id');
  }
  return { id: null, username };
}

/** Orders without any payment (they may be deleted) and with one (they stay). */
const hasMoney = (o: { status: OrderStatus; amountPaid: number; amountSubmitted: number }): boolean =>
  isSaleStatus(o.status) || o.amountPaid > 0 || o.amountSubmitted > 0;

async function holdings(
  db: Database,
  userId: number,
  shopId: string | null,
): Promise<{ cartItems: number; unpaid: { id: string; shopId: string }[]; paid: number; shops: number }> {
  const orderRows = await db
    .select({
      id: orders.id,
      shopId: orders.shopId,
      status: orders.status,
      amountPaid: orders.amountPaid,
      amountSubmitted: orders.amountSubmitted,
    })
    .from(orders)
    .where(and(eq(orders.userId, userId), shopId ? eq(orders.shopId, shopId) : undefined));
  const cartRows = await db
    .select({ shopId: carts.shopId, items: sql<number>`coalesce(sum(${cartItems.quantity}), 0)::int` })
    .from(carts)
    .leftJoin(cartItems, eq(cartItems.cartId, carts.id))
    .where(and(eq(carts.userId, userId), shopId ? eq(carts.shopId, shopId) : undefined))
    .groupBy(carts.shopId);
  const unpaid = orderRows.filter((o) => !hasMoney(o)).map((o) => ({ id: o.id, shopId: o.shopId }));
  const touched = new Set([
    ...orderRows.map((o) => o.shopId),
    ...cartRows.filter((c) => Number(c.items) > 0).map((c) => c.shopId),
  ]);
  return {
    cartItems: cartRows.reduce((sum, c) => sum + Number(c.items), 0),
    unpaid,
    paid: orderRows.filter(hasMoney).length,
    shops: touched.size,
  };
}

/** What someone has in the GB (or in every GB), so the admin decides before blocking. */
export async function checkBlacklist(
  db: Database,
  who: string,
  shopId: string | null,
): Promise<BlacklistCheck> {
  const person = await resolveWho(db, who);
  if (person.id === null) {
    return {
      label: `@${person.username}`,
      telegramId: null,
      cartItems: 0,
      unpaidOrders: 0,
      paidOrders: 0,
      shops: 0,
    };
  }
  const has = await holdings(db, person.id, shopId);
  return {
    label: await describeUser(db, person.id),
    telegramId: person.id,
    cartItems: has.cartItems,
    unpaidOrders: has.unpaid.length,
    paidOrders: has.paid,
    shops: has.shops,
  };
}

/** Deletes their carts and orders without payment (paid ones always stay). */
async function removeData(db: Database, userId: number, shopId: string | null): Promise<void> {
  const has = await holdings(db, userId, shopId);
  for (const order of has.unpaid) await deleteOrder(db, order.shopId, order.id);
  await db
    .delete(carts)
    .where(and(eq(carts.userId, userId), shopId ? eq(carts.shopId, shopId) : undefined));
}

function added(list: Blacklist, person: { id: number | null; username: string | null }): Blacklist {
  if (person.id !== null) {
    return list.userIds.includes(person.id) ? list : { ...list, userIds: [...list.userIds, person.id] };
  }
  const name = person.username ?? '';
  return list.usernames.includes(name) ? list : { ...list, usernames: [...list.usernames, name] };
}

function removed(list: Blacklist, person: { id: number | null; username: string | null }): Blacklist {
  return {
    userIds: list.userIds.filter((id) => id !== person.id),
    usernames: list.usernames.filter((u) => u !== person.username),
  };
}

export async function addToShopBlacklist(
  db: Database,
  env: Env,
  shop: ShopRow,
  who: string,
  deleteTheirData: boolean,
): Promise<BlacklistView> {
  const person = await resolveWho(db, who);
  if (person.id !== null && canManageShop(env, shop, person.id)) {
    throw ApiError.badRequest('team_member', "The GB's team cannot be blacklisted");
  }
  const list = added(normalize(shop.blacklist), person);
  await db.update(shops).set({ blacklist: list }).where(eq(shops.id, shop.id));
  if (deleteTheirData && person.id !== null) await removeData(db, person.id, shop.id);
  return view(db, list);
}

export async function removeFromShopBlacklist(
  db: Database,
  shop: ShopRow,
  who: string,
): Promise<BlacklistView> {
  const person = await resolveWho(db, who);
  const list = removed(normalize(shop.blacklist), person);
  await db.update(shops).set({ blacklist: list }).where(eq(shops.id, shop.id));
  return view(db, list);
}

export async function addToPlatformBlacklist(
  db: Database,
  env: Env,
  who: string,
  deleteTheirData: boolean,
): Promise<BlacklistView> {
  const person = await resolveWho(db, who);
  if (person.id !== null && isSuperAdmin(env, person.id)) {
    throw ApiError.badRequest('team_member', 'Platform admins cannot be blacklisted');
  }
  const list = added(await getPlatformBlacklist(db), person);
  await savePlatformBlacklist(db, list);
  if (deleteTheirData && person.id !== null) await removeData(db, person.id, null);
  return view(db, list);
}

export async function removeFromPlatformBlacklist(db: Database, who: string): Promise<BlacklistView> {
  const person = await resolveWho(db, who);
  const list = removed(await getPlatformBlacklist(db), person);
  await savePlatformBlacklist(db, list);
  return view(db, list);
}

/** Of the given customers, those blocked in this GB (for the team's order lists). */
export async function blockedAmong(
  db: Database,
  env: Env,
  shop: ShopRow,
  ids: readonly number[],
): Promise<Set<number>> {
  const allowed = new Set(await withoutBlocked(db, env, shop, ids));
  return new Set(ids.filter((id) => !allowed.has(id)));
}
