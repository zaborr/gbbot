import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { botSettings, botSwitches, bots } from '../db/schema.js';
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
  return active?.token ?? env.BOT_TOKEN ?? '';
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

/** A fingerprint of a token (the token itself is never stored in clear). */
const fingerprint = (token: string): string => createHash('sha256').update(`gb-env:${token}`).digest('hex');

/**
 * Loads the active bot at startup.
 * - Nothing stored yet: BOT_TOKEN from .env becomes the active bot.
 * - BOT_TOKEN changed in .env since the last start (changed by hand) and
 *   Telegram accepts it: it becomes the active bot (the previous one is kept
 *   as down). A token Telegram refuses never takes over.
 * - Otherwise the stored active bot wins (a switch made from the panel), even
 *   if the .env bot was forgotten in the panel.
 */
export async function loadActiveBot(
  db: Database,
  env: Env,
  telegram = new TelegramApi(env.BOT_TOKEN ?? ''),
): Promise<void> {
  const key = secretKey(env);
  const stored = await db.query.bots.findFirst({ where: eq(bots.status, 'active') });
  if (!env.BOT_TOKEN) {
    // No token in .env: the stored active bot is the one (nothing to compare).
    const token = stored ? open(key, stored.token) : null;
    if (stored && token) useBot({ id: stored.id, username: stored.username, token });
    else console.error('No bot: set BOT_TOKEN in .env for the first start (later the panel keeps it).');
    return;
  }
  const envToken = env.BOT_TOKEN;
  const envId = tokenBotId(envToken);
  const settings =
    (await db.query.botSettings.findFirst()) ??
    (await db.insert(botSettings).values({ id: 1 }).onConflictDoNothing().returning())[0] ??
    (await db.query.botSettings.findFirst());
  const envHash = fingerprint(envToken);
  const envChanged = settings?.envTokenHash !== envHash;
  if (envChanged) await db.update(botSettings).set({ envTokenHash: envHash }).where(eq(botSettings.id, 1));

  let adopt = !stored && envId !== null;
  let me: { id: number; username: string | null } | null = null;
  if (!adopt && envChanged && envId !== null && envId !== stored?.id) {
    // Only a token that works takes over.
    try {
      const answer = await telegram.getMe();
      me = { id: answer.id, username: answer.username ?? null };
      adopt = true;
    } catch (error) {
      console.warn('BOT_TOKEN in .env changed but Telegram does not accept it: the active bot stays.', error instanceof Error ? error.message : error);
    }
  }

  if (adopt && envId !== null) {
    me ??= await whoIs(envToken, telegram);
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
        .values({ id, username: me?.username ?? null, token: seal(key, envToken), status: 'active', activatedAt: new Date() })
        .onConflictDoUpdate({
          target: bots.id,
          set: { token: seal(key, envToken), status: 'active', activatedAt: new Date(), downAt: null, downReason: null },
        });
      await tx.insert(botSwitches).values({ fromBotId: stored?.id ?? null, toBotId: id, reason: 'env', byUser: null });
    });
    useBot({ id, username: me?.username ?? null, token: envToken });
    return;
  }

  const token = stored ? open(key, stored.token) : null;
  if (stored && token) {
    useBot({ id: stored.id, username: stored.username, token });
    // Learn the @ if it was not known (Telegram unreachable the first time).
    if (!stored.username) {
      const known = await whoIs(token, new TelegramApi(token));
      if (known?.username) {
        await db.update(bots).set({ username: known.username }).where(eq(bots.id, stored.id));
        useBot({ id: stored.id, username: known.username, token });
      }
    }
    return;
  }
  if (stored) console.error('The active bot token cannot be decrypted (BOTS_KEY or JWT_SECRET changed?): using BOT_TOKEN.');
  useBot(null);
}
