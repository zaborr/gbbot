import { and, count, desc, eq, gt, lt } from 'drizzle-orm';
import { LANGS, type Lang, type WebNotice } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { shops, webAdmins, webNotices } from '../db/schema.js';
import { notifyUsers } from './notifications.js';
import { teamIds, type ShopRow } from './shop.js';

/** Notices older than this leave the inbox. */
const KEEP_DAYS = 90;
const LIST_LIMIT = 100;

/** Puts a notice in the web administrators' inbox, in every app language. */
export async function addWebNotice(
  db: Database,
  build: (lang: Lang) => string,
  shopId: string | null = null,
): Promise<void> {
  const texts = Object.fromEntries(LANGS.map((lang) => [lang, build(lang)]));
  if (!texts.en) return;
  await db.insert(webNotices).values({ shopId, texts });
  const oldest = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(webNotices).where(lt(webNotices.createdAt, oldest));
}

/**
 * Tells the platform administrators: the Telegram ones through the bot
 * (ADMIN_TELEGRAM_IDS, may be empty) and the web ones in their inbox.
 */
export async function notifyPlatform(
  db: Database,
  env: Env,
  build: (lang: Lang) => string,
  shopId: string | null = null,
): Promise<void> {
  await notifyUsers(db, env.BOT_TOKEN, [...env.ADMIN_TELEGRAM_IDS], build);
  await addWebNotice(db, build, shopId);
}

/**
 * Tells a GB's team about its orders. A GB without a team falls back to the
 * platform administrators; with `platformToo` (wallet or key changes) they
 * always hear it as well.
 */
export async function notifyShopTeam(
  db: Database,
  env: Env,
  shop: ShopRow,
  build: (lang: Lang) => string,
  { platformToo = false }: { platformToo?: boolean } = {},
): Promise<void> {
  const team = teamIds(shop);
  const toPlatform = platformToo || team.length === 0;
  const chats = toPlatform ? [...new Set([...team, ...env.ADMIN_TELEGRAM_IDS])] : team;
  await notifyUsers(db, env.BOT_TOKEN, chats, build);
  if (toPlatform) await addWebNotice(db, build, shop.id);
}

/** The inbox, newest first, in the admin's language. */
export async function listWebNotices(
  db: Database,
  adminId: number,
  lang: Lang,
): Promise<{ notices: WebNotice[]; unread: number }> {
  const seen = await seenId(db, adminId);
  const rows = await db
    .select({
      id: webNotices.id,
      texts: webNotices.texts,
      createdAt: webNotices.createdAt,
      shopSlug: shops.slug,
    })
    .from(webNotices)
    .leftJoin(shops, eq(webNotices.shopId, shops.id))
    .orderBy(desc(webNotices.id))
    .limit(LIST_LIMIT);
  const notices = rows.map((row) => ({
    id: row.id,
    text: row.texts[lang] ?? row.texts.en ?? '',
    shopSlug: row.shopSlug,
    createdAt: row.createdAt.toISOString(),
    unread: row.id > seen,
  }));
  return { notices, unread: await unreadWebNotices(db, adminId) };
}

export async function unreadWebNotices(db: Database, adminId: number): Promise<number> {
  const seen = await seenId(db, adminId);
  const [row] = await db.select({ n: count() }).from(webNotices).where(gt(webNotices.id, seen));
  return row?.n ?? 0;
}

/** Marks the inbox as read up to `upTo` (never goes back). */
export async function markWebNoticesSeen(db: Database, adminId: number, upTo: number): Promise<void> {
  await db
    .update(webAdmins)
    .set({ noticesSeenId: upTo })
    .where(and(eq(webAdmins.id, adminId), lt(webAdmins.noticesSeenId, upTo)));
}

async function seenId(db: Database, adminId: number): Promise<number> {
  const row = await db.query.webAdmins.findFirst({
    where: eq(webAdmins.id, adminId),
    columns: { noticesSeenId: true },
  });
  return row?.noticesSeenId ?? 0;
}
