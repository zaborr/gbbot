import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { customerNotices, platformSettings, users, webKeys } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { setTelegramMirror } from '../telegram/api.js';

/** How long a key lets a customer in. */
const KEY_DAYS = 30;
/** Notices kept for a customer on the web. */
const NOTICE_DAYS = 90;
const NOTICES_SHOWN = 100;

const WORDS = [
  'pato', 'nube', 'lima', 'faro', 'sol', 'mar', 'roca', 'pino', 'lobo', 'rio',
  'gato', 'luna', 'flor', 'onda', 'trigo', 'cielo', 'nieve', 'perla', 'barco', 'monte',
];
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A key easy to copy and impossible to guess: word-XXXX-XXXX-XXXX-word (60+ bits). */
function newKey(): string {
  const bytes = randomBytes(16);
  const block = (from: number): string =>
    Array.from({ length: 4 }, (_, i) => CHARS[bytes[from + i]! % CHARS.length]).join('');
  return `${WORDS[bytes[12]! % WORDS.length]}-${block(0)}-${block(4)}-${block(8)}-${WORDS[bytes[13]! % WORDS.length]}`;
}

/** Keys are kept only as a hash; typed in any case, with or without dashes. */
export function keyHash(key: string): string {
  const clean = key.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHash('sha256').update(clean).digest('hex');
}

/** Those with a key in force: what the bot tells them is also kept for the web. */
const keyed = new Set<number>();

export async function loadKeyed(db: Database): Promise<void> {
  const rows = await db
    .selectDistinct({ userId: webKeys.userId })
    .from(webKeys)
    .where(and(isNull(webKeys.revokedAt), gt(webKeys.expiresAt, new Date())));
  keyed.clear();
  for (const r of rows) keyed.add(r.userId);
}

/** Every bot message to someone with a key also goes to their web inbox (best effort). */
export function mirrorToWeb(db: Database): void {
  setTelegramMirror((chatId, text) => {
    if (!keyed.has(chatId) || !text) return;
    void db
      .insert(customerNotices)
      .values({ userId: chatId, text })
      .catch((error: unknown) => console.error('Could not keep a web notice:', error));
  });
}

export async function webKeyValid(db: Database, keyId: string): Promise<boolean> {
  const row = await db.query.webKeys.findFirst({ where: eq(webKeys.id, keyId), columns: { revokedAt: true, expiresAt: true } });
  return Boolean(row && !row.revokedAt && row.expiresAt > new Date());
}

/** An organiser gives a customer a key for the GB (a new one replaces theirs). The key, once. */
export async function giveKey(
  db: Database,
  shopId: string,
  userId: number,
  by: number,
): Promise<{ key: string; expiresAt: string }> {
  const person = await db.query.users.findFirst({ where: eq(users.telegramId, userId), columns: { telegramId: true } });
  if (!person) throw ApiError.notFound('This person is not in the GB yet: add them first');
  await db
    .update(webKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(webKeys.shopId, shopId), eq(webKeys.userId, userId), isNull(webKeys.revokedAt)));
  const key = newKey();
  const expiresAt = new Date(Date.now() + KEY_DAYS * 24 * 3600_000);
  await db.insert(webKeys).values({ shopId, userId, hash: keyHash(key), createdBy: by, expiresAt });
  keyed.add(userId);
  return { key, expiresAt: expiresAt.toISOString() };
}

export async function revokeKeys(db: Database, shopId: string, userId: number): Promise<void> {
  await db
    .update(webKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(webKeys.shopId, shopId), eq(webKeys.userId, userId), isNull(webKeys.revokedAt)));
  await loadKeyed(db);
}

/** The key in force a customer has in a GB, for the organisers' view. */
export async function keyOf(
  db: Database,
  shopId: string,
  userId: number,
): Promise<{ createdAt: string; expiresAt: string; lastUsedAt: string | null } | null> {
  const [row] = await db
    .select()
    .from(webKeys)
    .where(and(eq(webKeys.shopId, shopId), eq(webKeys.userId, userId), isNull(webKeys.revokedAt), gt(webKeys.expiresAt, new Date())))
    .orderBy(desc(webKeys.createdAt))
    .limit(1);
  return row
    ? {
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      }
    : null;
}

/** Someone new, added by the organisers (by Telegram ID) so they can be given a key. */
export async function addCustomer(
  db: Database,
  input: { telegramId: number; username: string | null; firstName: string },
): Promise<void> {
  const username = input.username?.replace(/^@/, '').trim() || null;
  await db
    .insert(users)
    .values({ telegramId: input.telegramId, firstName: input.firstName.trim() || String(input.telegramId), username })
    .onConflictDoNothing();
}

/** A pasted key: whose, which GB, until when (or nothing: wrong, taken back or expired). */
export async function signInWithKey(
  db: Database,
  key: string,
): Promise<{ keyId: string; userId: number; shopId: string; expiresAt: Date } | null> {
  const row = await db.query.webKeys.findFirst({ where: eq(webKeys.hash, keyHash(key)) });
  if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
  await db.update(webKeys).set({ lastUsedAt: new Date() }).where(eq(webKeys.id, row.id));
  return { keyId: row.id, userId: row.userId, shopId: row.shopId, expiresAt: row.expiresAt };
}

/** A customer's web inbox, newest first. */
export async function noticesOf(db: Database, userId: number): Promise<Array<{ id: string; text: string; at: string }>> {
  await db
    .delete(customerNotices)
    .where(and(eq(customerNotices.userId, userId), lt(customerNotices.createdAt, new Date(Date.now() - NOTICE_DAYS * 24 * 3600_000))));
  const rows = await db
    .select()
    .from(customerNotices)
    .where(eq(customerNotices.userId, userId))
    .orderBy(desc(customerNotices.createdAt))
    .limit(NOTICES_SHOWN);
  return rows.map((r) => ({ id: r.id, text: r.text, at: r.createdAt.toISOString() }));
}

/** The message on the web's entrance (the bot is down…). */
export async function webBanner(db: Database): Promise<string | null> {
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1), columns: { webBanner: true } });
  return row?.webBanner ?? null;
}

export async function setWebBanner(db: Database, text: string | null): Promise<void> {
  const value = text?.trim() || null;
  await db
    .insert(platformSettings)
    .values({ id: 1, webBanner: value })
    .onConflictDoUpdate({ target: platformSettings.id, set: { webBanner: value, updatedAt: new Date() } });
}

