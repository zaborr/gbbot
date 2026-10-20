import { lte } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { expiringBotMessages } from '../db/schema.js';
import { TelegramApi } from '../telegram/api.js';

/** The bot deletes these after this long (Telegram lets it for 48 hours). */
export const SHIPPING_LIST_TTL_MS = 24 * 60 * 60 * 1000;

/** Remembers a message the bot must delete later. */
export async function deleteLater(
  db: Database,
  chatId: number,
  messageId: number,
  afterMs = SHIPPING_LIST_TTL_MS,
): Promise<void> {
  await db
    .insert(expiringBotMessages)
    .values({ chatId, messageId, deleteAt: new Date(Date.now() + afterMs) });
}

/** Deletes the messages whose time has come (best effort: gone already is fine). */
export async function deleteExpiredMessages(
  db: Database,
  env: Env,
  telegram = new TelegramApi(env.BOT_TOKEN),
  now = new Date(),
): Promise<number> {
  const due = await db
    .delete(expiringBotMessages)
    .where(lte(expiringBotMessages.deleteAt, now))
    .returning();
  for (const message of due) {
    try {
      await telegram.deleteMessage(message.chatId, message.messageId);
    } catch (error) {
      console.warn('Could not delete an expired bot message:', error instanceof Error ? error.message : error);
    }
  }
  return due.length;
}
