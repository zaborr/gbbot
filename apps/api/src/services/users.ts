import { eq } from 'drizzle-orm';
import type { Lang } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import type { InitDataUser } from '../auth/init-data.js';

type UserRow = typeof users.$inferSelect;

/**
 * Inserts or updates a user from validated initData, keeping the profile fresh
 * on every login. Who is a platform admin is not stored: it comes from
 * ADMIN_TELEGRAM_IDS on each login.
 */
export async function upsertUser(db: Database, tgUser: InitDataUser): Promise<UserRow> {
  const profile = {
    // Only what the shop needs: no surname, photo or Premium status.
    firstName: tgUser.first_name,
    username: tgUser.username ?? null,
    languageCode: tgUser.language_code ?? null,
    lastSeenAt: new Date(),
  };

  const [row] = await db
    .insert(users)
    .values({
      telegramId: tgUser.id,
      ...profile,
    })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: profile,
    })
    .returning();

  if (!row) throw new Error('Failed to upsert user');
  return row;
}

export async function getUser(db: Database, telegramId: number): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.telegramId, telegramId) });
}

/** Saves the language chosen in the app (null = follow Telegram again). */
export async function setPreferredLanguage(
  db: Database,
  telegramId: number,
  language: Lang | null,
): Promise<UserRow> {
  const [row] = await db
    .update(users)
    .set({ preferredLang: language })
    .where(eq(users.telegramId, telegramId))
    .returning();
  if (!row) throw new Error('User not found');
  return row;
}
