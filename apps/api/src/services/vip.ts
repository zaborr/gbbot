import { eq } from 'drizzle-orm';
import {
  EMPTY_VIP_CLUB,
  type ShopVipClub,
  type UpdateVipClubRequest,
  type VipClub,
  type VipGroup,
} from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { platformSettings, shops, users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi, type TelegramChatMember } from '../telegram/api.js';
import type { ShopRow } from './shop.js';

/** How long a group membership answer is trusted. */
const MEMBER_TTL_MS = 6 * 60 * 60 * 1000;
/** Shorter for "not a member", so someone who just joined is recognised soon. */
const NOT_MEMBER_TTL_MS = 5 * 60 * 1000;

/**
 * Group membership answers, in memory only: nothing about who is in which
 * group is stored in the database. A restart simply asks Telegram again.
 */
const membershipCache = new Map<string, { member: boolean; until: number }>();

export function resetVipCache(): void {
  membershipCache.clear();
}

/** Whether a getChatMember answer means "in the chat". */
export function isMemberStatus(member: TelegramChatMember): boolean {
  return (
    member.status === 'creator' ||
    member.status === 'administrator' ||
    member.status === 'member' ||
    (member.status === 'restricted' && member.is_member === true)
  );
}

/** The bot's own user id: the number before ":" in its token. */
export function botIdOf(botToken: string): number | null {
  const id = Number(botToken.split(':')[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Whether `userId` is in the group/channel, asking Telegram at most every few hours. */
export async function isGroupMember(
  telegram: TelegramApi,
  chatId: number,
  userId: number,
  now = Date.now(),
): Promise<boolean> {
  const key = `${chatId}:${userId}`;
  const cached = membershipCache.get(key);
  if (cached && cached.until > now) return cached.member;
  let member = false;
  try {
    member = isMemberStatus(await telegram.getChatMember(chatId, userId));
  } catch (error) {
    // Bot removed from the group, group deleted, Telegram down…: not VIP for now.
    console.warn(`VIP check in chat ${chatId} failed:`, error instanceof Error ? error.message : error);
  }
  membershipCache.set(key, { member, until: now + (member ? MEMBER_TTL_MS : NOT_MEMBER_TTL_MS) });
  return member;
}

/** How someone appears in a club's hand-made list, if at all. */
export function listMatch(
  club: VipClub,
  userId: number,
  username: string | null,
): 'id' | 'username' | null {
  if (club.userIds.includes(userId)) return 'id';
  if (username && club.usernames.includes(username.toLowerCase())) return 'username';
  return null;
}

/** The club with `username` replaced by `userId` (usernames can change, ids cannot). */
export function claimUsername(club: VipClub, username: string, userId: number): VipClub {
  const name = username.toLowerCase();
  return {
    ...club,
    usernames: club.usernames.filter((u) => u !== name),
    userIds: club.userIds.includes(userId) ? club.userIds : [...club.userIds, userId],
  };
}

function normalizeClub(club: VipClub | null | undefined): VipClub {
  return {
    groups: club?.groups ?? [],
    userIds: club?.userIds ?? [],
    usernames: club?.usernames ?? [],
  };
}

/**
 * The two lists built the same way: VIPs (VIP prices, VIP-only products and
 * GBs) and guests (only let in to "VIP and guests" GBs, at normal prices).
 */
export type ClubKind = 'vip' | 'guest';

function ownClub(shop: ShopRow, kind: ClubKind): VipClub {
  return normalizeClub(kind === 'vip' ? shop.vipClub : shop.guestList);
}

function usesPlatformClub(shop: ShopRow, kind: ClubKind): boolean {
  return kind === 'vip' ? shop.useGlobalVipClub : shop.useGlobalGuests;
}

async function saveShopClub(db: Database, shopId: string, kind: ClubKind, club: VipClub): Promise<void> {
  await db
    .update(shops)
    .set(kind === 'vip' ? { vipClub: club } : { guestList: club })
    .where(eq(shops.id, shopId));
}

export async function getPlatformClub(db: Database, kind: ClubKind): Promise<VipClub> {
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1) });
  return normalizeClub((kind === 'vip' ? row?.vipClub : row?.guestList) ?? EMPTY_VIP_CLUB);
}

export function getPlatformVipClub(db: Database): Promise<VipClub> {
  return getPlatformClub(db, 'vip');
}

async function savePlatformClub(db: Database, club: VipClub, kind: ClubKind = 'vip'): Promise<void> {
  const set = kind === 'vip' ? { vipClub: club } : { guestList: club };
  await db
    .insert(platformSettings)
    .values({ id: 1, ...set, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.id, set: { ...set, updatedAt: new Date() } });
}

export function shopClubView(shop: ShopRow, kind: ClubKind): ShopVipClub {
  return { ...ownClub(shop, kind), useGlobalClub: usesPlatformClub(shop, kind) };
}

export function shopVipClubView(shop: ShopRow): ShopVipClub {
  return shopClubView(shop, 'vip');
}

/**
 * Checks, for one user, whether they are in a list (VIPs or guests) of given
 * shops. Loads the user and the platform list once, however many shops are checked.
 */
export function createClubChecker(
  db: Database,
  env: Env,
  userId: number,
  kind: ClubKind,
  telegram = new TelegramApi(env.BOT_TOKEN),
): (shop: ShopRow) => Promise<boolean> {
  let context: Promise<{ username: string | null; platform: VipClub }> | null = null;
  const load = (): Promise<{ username: string | null; platform: VipClub }> => {
    context ??= (async () => {
      const [user, platform] = await Promise.all([
        db.query.users.findFirst({ where: eq(users.telegramId, userId) }),
        getPlatformClub(db, kind),
      ]);
      return { username: user?.username ?? null, platform };
    })();
    return context;
  };

  return async (shop) => {
    const { username, platform } = await load();
    const own = ownClub(shop, kind);
    const usesPlatform = usesPlatformClub(shop, kind);

    // 1. Hand-made lists. A match by @username is turned into the id for good.
    const ownMatch = listMatch(own, userId, username);
    if (ownMatch === 'username' && username) {
      await saveShopClub(db, shop.id, kind, claimUsername(own, username, userId));
    }
    if (ownMatch) return true;
    if (usesPlatform) {
      const platformMatch = listMatch(platform, userId, username);
      if (platformMatch === 'username' && username) {
        await savePlatformClub(db, claimUsername(platform, username, userId), kind);
      }
      if (platformMatch) return true;
    }

    // 2. Telegram groups and channels.
    const chatIds = new Set(own.groups.map((g) => g.chatId));
    if (usesPlatform) for (const g of platform.groups) chatIds.add(g.chatId);
    for (const chatId of chatIds) {
      if (await isGroupMember(telegram, chatId, userId)) return true;
    }
    return false;
  };
}

export function createVipChecker(
  db: Database,
  env: Env,
  userId: number,
  telegram = new TelegramApi(env.BOT_TOKEN),
): (shop: ShopRow) => Promise<boolean> {
  return createClubChecker(db, env, userId, 'vip', telegram);
}

/** One-off check (e.g. when opening a single shop). */
export function isVipOf(db: Database, env: Env, shop: ShopRow, userId: number): Promise<boolean> {
  return createVipChecker(db, env, userId)(shop);
}

/** Whether a "VIP and guests" GB lets this guest in (VIPs are checked apart). */
export function isGuestOf(db: Database, env: Env, shop: ShopRow, userId: number): Promise<boolean> {
  return createClubChecker(db, env, userId, 'guest')(shop);
}

/**
 * Turns what the admin typed ("@publicgroup" or "-100…") into groups the bot
 * is really in. Groups already in the club are kept without asking again.
 */
export async function resolveGroups(
  telegram: TelegramApi,
  botToken: string,
  refs: string[],
  existing: VipGroup[],
): Promise<VipGroup[]> {
  const botId = botIdOf(botToken);
  const result = new Map<number, VipGroup>();
  for (const raw of refs) {
    const ref = raw.trim();
    const numeric = /^-?\d+$/.test(ref) ? Number(ref) : null;
    const known = numeric === null ? undefined : existing.find((g) => g.chatId === numeric);
    if (known) {
      result.set(known.chatId, known);
      continue;
    }
    const target = numeric ?? (ref.startsWith('@') ? ref : `@${ref.replace(/^https?:\/\/t\.me\//i, '')}`);
    let chat;
    try {
      chat = await telegram.getChat(target);
    } catch {
      throw ApiError.badRequest(
        'vip_group_not_found',
        `Telegram group "${ref}" not found. Add the bot to it first.`,
      );
    }
    if (chat.type === 'private') {
      throw ApiError.badRequest('vip_group_private', `"${ref}" is not a group or channel`);
    }
    const title = chat.title ?? (chat.username ? `@${chat.username}` : String(chat.id));
    let botIn = false;
    if (botId !== null) {
      try {
        botIn = isMemberStatus(await telegram.getChatMember(chat.id, botId));
      } catch {
        botIn = false;
      }
    }
    if (!botIn) {
      throw ApiError.badRequest(
        'vip_bot_not_in_group',
        `The bot is not in "${title}". Add it to the group (as an admin in channels) and try again.`,
      );
    }
    result.set(chat.id, { chatId: chat.id, title });
  }
  return [...result.values()];
}

async function clubFromRequest(
  env: Env,
  input: UpdateVipClubRequest,
  current: VipClub,
  telegram: TelegramApi,
): Promise<VipClub> {
  return {
    groups: await resolveGroups(telegram, env.BOT_TOKEN, input.groups, current.groups),
    userIds: [...new Set(input.userIds)],
    usernames: [...new Set(input.usernames.map((u) => u.toLowerCase()))],
  };
}

export async function updatePlatformClub(
  db: Database,
  env: Env,
  input: UpdateVipClubRequest,
  kind: ClubKind,
  telegram = new TelegramApi(env.BOT_TOKEN),
): Promise<VipClub> {
  const club = await clubFromRequest(env, input, await getPlatformClub(db, kind), telegram);
  await savePlatformClub(db, club, kind);
  return club;
}

export function updatePlatformVipClub(
  db: Database,
  env: Env,
  input: UpdateVipClubRequest,
  telegram = new TelegramApi(env.BOT_TOKEN),
): Promise<VipClub> {
  return updatePlatformClub(db, env, input, 'vip', telegram);
}

export async function updateShopClub(
  db: Database,
  env: Env,
  shop: ShopRow,
  input: UpdateVipClubRequest,
  kind: ClubKind,
  telegram = new TelegramApi(env.BOT_TOKEN),
): Promise<ShopVipClub> {
  const club = await clubFromRequest(env, input, ownClub(shop, kind), telegram);
  const useGlobal = input.useGlobalClub ?? usesPlatformClub(shop, kind);
  const [row] = await db
    .update(shops)
    .set(kind === 'vip' ? { vipClub: club, useGlobalVipClub: useGlobal } : { guestList: club, useGlobalGuests: useGlobal })
    .where(eq(shops.id, shop.id))
    .returning();
  if (!row) throw ApiError.notFound('Shop not found');
  return shopClubView(row, kind);
}

export function updateShopVipClub(
  db: Database,
  env: Env,
  shop: ShopRow,
  input: UpdateVipClubRequest,
  telegram = new TelegramApi(env.BOT_TOKEN),
): Promise<ShopVipClub> {
  return updateShopClub(db, env, shop, input, 'vip', telegram);
}
