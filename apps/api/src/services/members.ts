import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { groupMembers, orders, platformSettings, shops, users, webAdmins, webKeys } from '../db/schema.js';
import { managesSomething } from './team.js';
import { getPlatformClub, isGroupMember } from './vip.js';
import { TelegramApi } from '../telegram/api.js';
import { botToken } from './activeBot.js';

/**
 * Private mode: who is in. Members are whoever manages something (staff),
 * has a web account (they came in with an invitation), holds a web key, has
 * ever ordered, or is on a list (VIP or guests, of a GB or the platform).
 * Everyone else sees only the entrance.
 */

export interface PrivateSettings {
  privateMode: boolean;
  accountDeadline: Date | null;
}

let settingsCache: { value: PrivateSettings; until: number } | null = null;
const memberCache = new Map<number, { member: boolean; until: number }>();
const MEMBER_TTL_MS = 5 * 60_000;

export function forgetMembership(userId?: number): void {
  if (userId === undefined) memberCache.clear();
  else memberCache.delete(userId);
  settingsCache = null;
}

export async function privateSettings(db: Database): Promise<PrivateSettings> {
  const now = Date.now();
  if (settingsCache && settingsCache.until > now) return settingsCache.value;
  const row = await db.query.platformSettings.findFirst({
    columns: { privateMode: true, accountDeadline: true },
  });
  const value = { privateMode: row?.privateMode ?? false, accountDeadline: row?.accountDeadline ?? null };
  settingsCache = { value, until: now + 10_000 };
  return value;
}

export async function setPrivateSettings(db: Database, next: Partial<PrivateSettings>): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ id: 1, ...next })
    .onConflictDoUpdate({ target: platformSettings.id, set: { ...next, updatedAt: new Date() } });
  forgetMembership();
}

/** Why someone is a member (first reason found), or null. */
export async function memberReason(
  db: Database,
  env: Env,
  userId: number,
  /** Ask Telegram about groups (false: only what is remembered; for the preview of everyone). */
  live = true,
): Promise<'staff' | 'account' | 'key' | 'orders' | 'list' | 'group' | null> {
  if (await managesSomething(db, env, userId)) return 'staff';
  if (await db.query.webAdmins.findFirst({ where: eq(webAdmins.telegramId, userId), columns: { id: true } })) {
    return 'account';
  }
  if (await db.query.webKeys.findFirst({ where: eq(webKeys.userId, userId), columns: { id: true } })) return 'key';
  if (await db.query.orders.findFirst({ where: eq(orders.userId, userId), columns: { id: true } })) return 'orders';
  const user = await db.query.users.findFirst({ where: eq(users.telegramId, userId), columns: { username: true } });
  const id = JSON.stringify([userId]);
  const handle = user?.username?.toLowerCase();
  const name = handle ? JSON.stringify([handle]) : null;
  const inList = name
    ? sql`(
    ${shops.vipClub} -> 'userIds' @> ${id}::jsonb or ${shops.guestList} -> 'userIds' @> ${id}::jsonb or
    ${shops.vipClub} -> 'usernames' @> ${name}::jsonb or ${shops.guestList} -> 'usernames' @> ${name}::jsonb
  )`
    : sql`(${shops.vipClub} -> 'userIds' @> ${id}::jsonb or ${shops.guestList} -> 'userIds' @> ${id}::jsonb)`;
  if (await db.query.shops.findFirst({ where: inList, columns: { id: true } })) return 'list';
  const platformList = name
    ? sql`(
    ${platformSettings.vipClub} -> 'userIds' @> ${id}::jsonb or ${platformSettings.guestList} -> 'userIds' @> ${id}::jsonb or
    ${platformSettings.vipClub} -> 'usernames' @> ${name}::jsonb or ${platformSettings.guestList} -> 'usernames' @> ${name}::jsonb
  )`
    : sql`(${platformSettings.vipClub} -> 'userIds' @> ${id}::jsonb or ${platformSettings.guestList} -> 'userIds' @> ${id}::jsonb)`;
  if (await db.query.platformSettings.findFirst({ where: platformList, columns: { id: true } })) return 'list';
  // The member list (by id or @username) and every group of the lists (members,
  // VIP, guests, of the platform or a GB): the bot checks, or what was last known.
  const club = await getPlatformClub(db, 'member');
  if (club.userIds.includes(userId) || (handle !== undefined && club.usernames.includes(handle))) return 'list';
  const groups = new Set<number>(club.groups.map((g) => g.chatId));
  const settings = await db.query.platformSettings.findFirst({ columns: { vipClub: true, guestList: true } });
  for (const g of [...(settings?.vipClub.groups ?? []), ...(settings?.guestList.groups ?? [])]) groups.add(g.chatId);
  const shopClubs = await db.select({ vip: shops.vipClub, guest: shops.guestList }).from(shops);
  for (const s of shopClubs) for (const g of [...s.vip.groups, ...s.guest.groups]) groups.add(g.chatId);
  if (groups.size > 0 && !live) {
    const seen = await db
      .select({ chatId: groupMembers.chatId })
      .from(groupMembers)
      .where(and(eq(groupMembers.userId, userId), inArray(groupMembers.chatId, [...groups])))
      .limit(1);
    return seen.length > 0 ? 'group' : null;
  }
  if (groups.size > 0) {
    const telegram = new TelegramApi(botToken(env));
    for (const chatId of groups) {
      if (await isGroupMember(telegram, chatId, userId, Date.now(), db)) return 'group';
    }
  }
  return null;
}

export async function isMember(db: Database, env: Env, userId: number): Promise<boolean> {
  const now = Date.now();
  const cached = memberCache.get(userId);
  if (cached && cached.until > now) return cached.member;
  const member = (await memberReason(db, env, userId)) !== null;
  memberCache.set(userId, { member, until: now + MEMBER_TTL_MS });
  if (memberCache.size > 20_000) memberCache.clear();
  return member;
}

/**
 * What stands between a session and the GBs: nothing, the entrance (not a
 * member), or making their web account (a member through Telegram, after the
 * deadline, with no account yet).
 */
export async function gateFor(
  db: Database,
  env: Env,
  claims: { sub: number; wid?: number | undefined; ck?: string | undefined } | undefined,
): Promise<'none' | 'invite' | 'account'> {
  const settings = await privateSettings(db);
  if (!settings.privateMode || !claims) return settings.privateMode ? 'invite' : 'none';
  // Platform web accounts (negative ids) and web keys given by the staff: in.
  if (claims.sub < 0 || claims.ck !== undefined) return 'none';
  if (!(await isMember(db, env, claims.sub))) return 'invite';
  const deadline = settings.accountDeadline;
  if (deadline && deadline.getTime() <= Date.now() && claims.wid === undefined) {
    const hasAccount = await db.query.webAdmins.findFirst({ where: eq(webAdmins.telegramId, claims.sub), columns: { id: true } });
    if (!hasAccount && !(await managesSomething(db, env, claims.sub))) return 'account';
  }
  return 'none';
}

/**
 * Before switching private mode on: how many would be in, by reason, and the
 * people who are in only because they once ordered (to look over).
 */
export async function privatePreview(db: Database, env: Env): Promise<{
  total: number;
  byReason: Record<string, number>;
  onlyOrders: Array<{ telegramId: number; name: string }>;
}> {
  const people = await db.select({ id: users.telegramId, firstName: users.firstName, username: users.username }).from(users);
  const byReason: Record<string, number> = {};
  const onlyOrders: Array<{ telegramId: number; name: string }> = [];
  let total = 0;
  for (const p of people) {
    const reason = await memberReason(db, env, p.id, false);
    if (!reason) continue;
    total += 1;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (reason === 'orders') onlyOrders.push({ telegramId: p.id, name: p.username ? `${p.firstName} (@${p.username})` : p.firstName });
  }
  return { total, byReason, onlyOrders };
}
