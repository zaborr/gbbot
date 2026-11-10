import { eq } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { bots } from '../db/schema.js';
import { open, seal, secretKey } from '../lib/secretBox.js';
import { TelegramApi } from '../telegram/api.js';

/**
 * The bot the platform answers as. It lives in the database so it can change
 * (Telegram closed it, a spare takes over) without touching .env or
 * restarting. Until it is loaded, BOT_TOKEN from .env is used.
 */
interface ActiveBot {
  id: number;
  username: string | null;
  token: string;
}

let active: ActiveBot | null = null;

/** The token to talk to Telegram with. */
export function botToken(env: Pick<Env, 'BOT_TOKEN'>): string {
  return active?.token ?? env.BOT_TOKEN;
}

/** The active bot's @ (without it), when known. */
export function botUsername(): string | null {
  return active?.username ?? null;
}

/** A Bot API client for the active bot. */
export function activeTelegram(env: Pick<Env, 'BOT_TOKEN'>): TelegramApi {
  return new TelegramApi(botToken(env));
}

/** The id before ":" in a token, or null when it is not a token. */
export function tokenBotId(token: string): number | null {
  const id = Number(token.split(':')[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Test hook and for switching: the bot used from now on (null = back to .env). */
export function useBot(bot: ActiveBot | null): void {
  active = bot;
}

/** Who a token belongs to, asking Telegram; null when it cannot be reached. */
async function whoIs(token: string, telegram: TelegramApi): Promise<{ id: number; username: string | null } | null> {
  try {
    const me = await telegram.getMe();
    return { id: me.id, username: me.username ?? null };
  } catch (error) {
    console.error('Could not ask Telegram who the bot is:', error);
    const id = tokenBotId(token);
    return id === null ? null : { id, username: null };
  }
}

/**
 * Loads the active bot at startup.
 * - Nothing stored yet: BOT_TOKEN from .env becomes the active bot.
 * - BOT_TOKEN is a bot the table has never seen: it was changed by hand in
 *   .env, so it becomes the active bot (the previous one is kept as down).
 * - Otherwise the stored active bot wins (a switch made from the panel).
 */
export async function loadActiveBot(
  db: Database,
  env: Env,
  telegram = new TelegramApi(env.BOT_TOKEN),
): Promise<void> {
  const key = secretKey(env);
  const envId = tokenBotId(env.BOT_TOKEN);
  const known = envId === null ? undefined : await db.query.bots.findFirst({ where: eq(bots.id, envId) });
  const stored = await db.query.bots.findFirst({ where: eq(bots.status, 'active') });

  if (!known && envId !== null) {
    const me = await whoIs(env.BOT_TOKEN, telegram);
    const id = me?.id ?? envId;
    await db.transaction(async (tx) => {
      if (stored) {
        await tx
          .update(bots)
          .set({ status: 'down', downAt: new Date(), downReason: 'env' })
          .where(eq(bots.id, stored.id));
      }
      await tx
        .insert(bots)
        .values({ id, username: me?.username ?? null, token: seal(key, env.BOT_TOKEN), status: 'active', activatedAt: new Date() })
        .onConflictDoNothing();
    });
    useBot({ id, username: me?.username ?? null, token: env.BOT_TOKEN });
    return;
  }

  const token = stored ? open(key, stored.token) : null;
  if (stored && token) {
    useBot({ id: stored.id, username: stored.username, token });
    // Learn the @ if it was not known (Telegram unreachable the first time).
    if (!stored.username) {
      const me = await whoIs(token, new TelegramApi(token));
      if (me?.username) {
        await db.update(bots).set({ username: me.username }).where(eq(bots.id, stored.id));
        useBot({ id: stored.id, username: me.username, token });
      }
    }
    return;
  }
  if (stored) console.error('The active bot token cannot be decrypted (BOTS_KEY or JWT_SECRET changed?): using BOT_TOKEN.');
  useBot(null);
}
