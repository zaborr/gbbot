import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { LANGS, type BotInfo, type BotSwitchReason, type BotsOverview } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { botSwitches, bots, shops, testings } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { open, seal, secretKey } from '../lib/secretBox.js';
import { TelegramApi } from '../telegram/api.js';
import { tr } from '../i18n/messages.js';
import { botToken, tokenBotId, useBot } from './activeBot.js';
import { languagesOf } from './notifications.js';
import { notifyPlatform } from './webNotices.js';
import { testedLabel } from './testingDraw.js';
import { webhookUrl } from './bot.js';
import { announceSwitch } from './botNotices.js';

type BotRow = typeof bots.$inferSelect;

export const toInfo = (row: BotRow): BotInfo => ({
  id: row.id,
  username: row.username,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  activatedAt: row.activatedAt?.toISOString() ?? null,
  downAt: row.downAt?.toISOString() ?? null,
  downReason: row.downReason,
  accountId: row.accountId,
});

/** The bots, the last switches and whether the active bot still answers. */
export async function botsOverview(
  db: Database,
  env: Env,
  telegram = new TelegramApi(botToken(env)),
): Promise<Omit<BotsOverview, 'watch'>> {
  const rows = await db.select().from(bots).orderBy(desc(bots.createdAt));
  const active = rows.find((row) => row.status === 'active') ?? null;
  const switches = await db.select().from(botSwitches).orderBy(desc(botSwitches.at)).limit(30);
  const name = (id: number): string | null => rows.find((row) => row.id === id)?.username ?? null;
  let working = false;
  let menuUrl: string | null = null;
  try {
    await telegram.getMe();
    working = true;
    const button = await telegram.getChatMenuButton();
    menuUrl = button.type === 'web_app' ? (button.web_app?.url ?? null) : null;
  } catch {
    // Closed, or Telegram cannot be reached: either way it does not answer.
  }
  return {
    active: active ? toInfo(active) : null,
    working,
    menuUrl,
    bots: rows.filter((row) => row.status !== 'active').map(toInfo),
    history: switches.map((entry) => ({
      id: entry.id,
      at: entry.at.toISOString(),
      from: entry.fromBotId === null ? null : { id: entry.fromBotId, username: name(entry.fromBotId) },
      to: { id: entry.toBotId, username: name(entry.toBotId) },
      reason: entry.reason,
      notices: entry.notices ?? null,
    })),
  };
}

/** Where the Mini App is served: this server's address. */
export function miniAppAddress(env: Env): string | undefined {
  const base = env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL;
  return base ? `${base.replace(/\/+$/, '')}/` : undefined;
}

/** Puts the Mini App button on the active bot (this server's address). */
export async function setMenuButton(env: Env, telegram = new TelegramApi(botToken(env))): Promise<{ menuUrl: string }> {
  const url = miniAppAddress(env);
  if (!url) throw ApiError.conflict('no_public_url', 'PUBLIC_URL is not set');
  try {
    await telegram.setChatMenuButton(tr('en', 'start.button'), url);
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^Telegram \w+ failed: /, '') : String(error);
    throw ApiError.badRequest('bot_setup', `Telegram did not accept the setup (${detail})`);
  }
  return { menuUrl: url };
}

/**
 * Puts a new bot ready to work: webhook, the Mini App button and, if the old
 * bot still answers, its name, descriptions and commands.
 */
export async function prepareBot(env: Env, next: TelegramApi, old: TelegramApi | null, copyProfile = true): Promise<void> {
  const url = webhookUrl(env);
  if (url && env.TELEGRAM_WEBHOOK_SECRET) {
    await next.setWebhook(url, env.TELEGRAM_WEBHOOK_SECRET, ['message', 'my_chat_member', 'callback_query']);
  }
  // The Mini App button: the old bot's if it still answers, otherwise this server's address.
  const current = await next.getChatMenuButton().catch(() => null);
  if (current?.type !== 'web_app') {
    const oldButton = old ? await old.getChatMenuButton().catch(() => null) : null;
    const appUrl = oldButton?.type === 'web_app' ? oldButton.web_app?.url : miniAppAddress(env);
    if (appUrl) await next.setChatMenuButton(oldButton?.text ?? tr('en', 'start.button'), appUrl);
  }
  if (!old || !copyProfile) return;
  for (const lang of ['', ...LANGS]) {
    try {
      const profile = await old.getProfile(lang);
      if (profile.name || profile.description || profile.shortDescription) await next.setProfile(lang, profile);
      const commands = await old.getMyCommands(lang);
      if (commands.length > 0) await next.setMyCommands(lang, commands);
    } catch {
      // The old bot no longer answers: nothing to copy (it can be set in @BotFather).
      return;
    }
  }
}

/**
 * Another bot takes over: the token is checked with Telegram, the bot is set
 * up, the old one is kept as down and the platform administrators are told.
 * Everything else (orders, GBs, users) stays as it is.
 */
export async function switchBot(
  db: Database,
  env: Env,
  token: string,
  reason: BotSwitchReason,
  byUser: number | null,
  telegramFor: (token: string) => TelegramApi = (t) => new TelegramApi(t),
  /** A spare already has its name, descriptions and photo: nothing to copy. */
  { fromReserve = false }: { fromReserve?: boolean } = {},
): Promise<BotInfo> {
  const next = telegramFor(token);
  let me: { id: number; username?: string };
  try {
    me = await next.getMe();
  } catch {
    throw ApiError.badRequest('bot_token', 'Telegram does not accept this bot token');
  }
  const current = await db.query.bots.findFirst({ where: eq(bots.status, 'active') });
  if (current?.id === me.id || tokenBotId(botToken(env)) === me.id) {
    throw ApiError.conflict('bot_same', 'That is already the active bot');
  }
  const key = secretKey(env);
  const oldToken = current ? open(key, current.token) : botToken(env);
  try {
    await prepareBot(env, next, oldToken ? telegramFor(oldToken) : null, !fromReserve);
  } catch (error) {
    // Nothing was changed yet: the active bot stays as it was.
    const detail = error instanceof Error ? error.message.replace(/^Telegram \w+ failed: /, '') : String(error);
    throw ApiError.badRequest('bot_setup', `Telegram did not accept the setup (${detail})`);
  }

  const now = new Date();
  const username = me.username ?? null;
  const row = await db.transaction(async (tx) => {
    if (current) {
      await tx
        .update(bots)
        .set({ status: 'down', downAt: now, downReason: reason })
        .where(eq(bots.id, current.id));
    }
    const [saved] = await tx
      .insert(bots)
      .values({ id: me.id, username, token: seal(key, token), status: 'active', activatedAt: now })
      .onConflictDoUpdate({
        target: bots.id,
        set: { username, token: seal(key, token), status: 'active', activatedAt: now, downAt: null, downReason: null },
      })
      .returning();
    await tx.insert(botSwitches).values({ fromBotId: current?.id ?? null, toBotId: me.id, reason, byUser });
    return saved!;
  });
  useBot({ id: me.id, username, token });

  await reaskReports(db, next).catch((error: unknown) => console.error('Could not ask for the reports again:', error));
  await notifyPlatform(db, env, (lang) =>
    tr(lang, 'bots.switched', { bot: username ? `@${username}` : String(me.id), reason: tr(lang, `bots.reason.${reason}`) }),
  ).catch((error: unknown) => console.error('Could not tell about the new bot:', error));
  // Privately to the administrators, the channel and the groups: slow, so in the background.
  if (username) {
    void announceSwitch(db, env, username, reason).catch((error: unknown) =>
      console.error('Could not announce the new bot:', error),
    );
  }
  return toInfo(row);
}

/**
 * Lab reports asked for by the old bot: the organiser would reply to a bot
 * that is gone, so the new one asks again.
 */
async function reaskReports(db: Database, telegram: TelegramApi): Promise<void> {
  const pending = await db
    .select()
    .from(testings)
    .where(and(isNotNull(testings.reportRequest), isNull(testings.report)));
  if (pending.length === 0) return;
  const shopRows = await db.select().from(shops).where(inArray(shops.id, [...new Set(pending.map((t) => t.shopId))]));
  const chats = pending.map((t) => t.reportRequest!.chatId);
  const langs = await languagesOf(db, chats);
  for (const testing of pending) {
    const request = testing.reportRequest!;
    const shop = shopRows.find((s) => s.id === testing.shopId);
    if (!shop) continue;
    try {
      const sent = (await telegram.sendMessage(
        request.chatId,
        tr(langs.get(request.chatId) ?? 'en', 'testing.reportAsk', {
          shop: shop.name,
          product: await testedLabel(db, testing),
          lab: testing.lab,
        }),
      )) as { message_id?: number };
      if (typeof sent.message_id === 'number') {
        await db
          .update(testings)
          .set({ reportRequest: { chatId: request.chatId, messageId: sent.message_id } })
          .where(eq(testings.id, testing.id));
      }
    } catch (error) {
      // Not started the new bot yet: they can ask again from the app.
      await db.update(testings).set({ reportRequest: null }).where(eq(testings.id, testing.id));
      console.warn('Could not ask again for a lab report:', error instanceof Error ? error.message : error);
    }
  }
}
