import { langFrom, type Lang } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { languagesOf } from './notifications.js';
import { tr } from '../i18n/messages.js';
import { TelegramApi, type InlineKeyboard } from '../telegram/api.js';
import type { TelegramUpdate } from '../telegram/types.js';
import { handleUploadChoice, handleUploadedFile } from './uploads.js';
import { handleUpdateButton, isUpdateCommand, updateReply } from './serverUpdate.js';
import { isSuperAdmin } from './shop.js';

const MENU_CACHE_MS = 60 * 60 * 1000;

/** Where Telegram should send updates, or null when the webhook cannot be set up. */
export function webhookUrl(env: Env): string | null {
  const base = env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL;
  if (!base || !env.TELEGRAM_WEBHOOK_SECRET) return null;
  return `${base.replace(/\/+$/, '')}/webhook/telegram`;
}

let menuCache: { url: string | null; at: number } | null = null;

/**
 * The Mini App URL, read from the bot's menu button (set up in @BotFather), so
 * there is nothing else to configure. Cached for an hour.
 */
export async function miniAppUrl(telegram: TelegramApi, now = Date.now()): Promise<string | null> {
  if (menuCache && now - menuCache.at < MENU_CACHE_MS) return menuCache.url;
  let url: string | null = null;
  try {
    const button = await telegram.getChatMenuButton();
    url = button.type === 'web_app' ? (button.web_app?.url ?? null) : null;
  } catch (error) {
    console.error('Could not read the bot menu button:', error);
  }
  menuCache = { url, at: now };
  return url;
}

/** Test hook: forget the cached menu button. */
export function resetMiniAppUrlCache(): void {
  menuCache = null;
}

/** The bot's answer to /start (and to any other message in a private chat). */
export function buildStartReply(
  url: string | null,
  firstName: string | undefined,
  lang: Lang = 'en',
): { text: string; keyboard?: InlineKeyboard } {
  const hello = firstName ? tr(lang, 'start.hello', { name: firstName }) : tr(lang, 'start.helloAnon');
  const updates = tr(lang, 'start.updates');
  if (!url) {
    return { text: [`${hello} ${tr(lang, 'start.useMenu')}`, '', updates].join('\n') };
  }
  return {
    text: [`${hello} ${tr(lang, 'start.tapButton')}`, '', updates].join('\n'),
    keyboard: { inline_keyboard: [[{ text: tr(lang, 'start.button'), web_app: { url } }]] },
  };
}

/**
 * Answers people who write to the bot in a private chat: /start (or anything
 * else) gets a greeting with a button that opens the Mini App. Pressing Start
 * is also what lets the bot message the user later on.
 */
export async function handleBotMessage(
  env: Env,
  update: TelegramUpdate,
  telegram = new TelegramApi(env.BOT_TOKEN),
  db?: Database,
): Promise<void> {
  if (update.my_chat_member) {
    await handleAddedToChat(update.my_chat_member, telegram, db);
    return;
  }
  // Buttons under the bot's messages (choosing a GB for an uploaded CSV).
  if (update.callback_query) {
    const query = update.callback_query;
    const queryLang =
      (db ? (await languagesOf(db, [query.from.id])).get(query.from.id) : undefined) ??
      langFrom(query.from.language_code);
    if (await handleUpdateButton(env, telegram, query, queryLang)) return;
    if (db) {
      await handleUploadChoice(db, env, telegram, update.callback_query, await miniAppUrl(telegram));
    }
    return;
  }
  const message = update.message;
  // A CSV or backup sent to the bot: it offers to open the import screen.
  if (message?.document && message.chat?.type === 'private' && db) {
    await handleUploadedFile(db, env, telegram, message, await miniAppUrl(telegram));
    return;
  }
  if (!message?.text || message.chat?.type !== 'private') return;
  // The language chosen in the app wins over Telegram's.
  const fromId = message.from?.id;
  const known = db && fromId !== undefined ? (await languagesOf(db, [fromId])).get(fromId) : undefined;
  const lang = known ?? langFrom(message.from?.language_code);
  // Updating the server: platform administrators only (anyone else gets the greeting).
  if (fromId !== undefined && isUpdateCommand(message.text) && isSuperAdmin(env, fromId)) {
    const answer = await updateReply(env, lang);
    await telegram.sendMessage(message.chat.id, answer.text, answer.keyboard);
    return;
  }
  const reply = buildStartReply(await miniAppUrl(telegram), message.from?.first_name, lang);
  await telegram.sendMessage(message.chat.id, reply.text, reply.keyboard);
}

/** Best-effort bot setup at startup: registers the webhook so /start is answered. */
/** Waits between tries when Telegram cannot be reached at startup (~22 min in all). */
export const WEBHOOK_RETRY_DELAYS_MS = [10_000, 30_000, 120_000, 300_000, 900_000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

/**
 * Points the bot's webhook at this API. A network hiccup at startup (Telegram
 * not reachable for a moment) is retried a few times instead of giving up;
 * the webhook set on an earlier start keeps working meanwhile.
 */
export async function configureBot(
  env: Env,
  telegram = new TelegramApi(env.BOT_TOKEN),
  wait: (ms: number) => Promise<void> = sleep,
): Promise<boolean> {
  const url = webhookUrl(env);
  if (!url || !env.TELEGRAM_WEBHOOK_SECRET) {
    console.warn(
      'Telegram webhook not set: the bot will not answer /start. ' +
        'Set TELEGRAM_WEBHOOK_SECRET (and PUBLIC_URL outside Render).',
    );
    return false;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await telegram.setWebhook(url, env.TELEGRAM_WEBHOOK_SECRET, [
        'message',
        'my_chat_member',
        'callback_query',
      ]);
      console.log(`Telegram webhook set to ${url}`);
      return true;
    } catch (error) {
      const delay = WEBHOOK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.error('Could not set the Telegram webhook, giving up:', error);
        return false;
      }
      console.warn(
        `Could not set the Telegram webhook (try ${attempt + 1}), retrying in ${delay / 1000} s:`,
        error instanceof Error ? error.message : error,
      );
      await wait(delay);
    }
  }
}

/**
 * When someone adds the bot to a group or channel, tell them (privately) the
 * chat id, which is what a VIP club needs for private groups.
 */
export async function handleAddedToChat(
  event: NonNullable<TelegramUpdate['my_chat_member']>,
  telegram: TelegramApi,
  db?: Database,
): Promise<void> {
  const { chat, from, new_chat_member: member } = event;
  if (chat.type === 'private') return;
  if (member.status !== 'member' && member.status !== 'administrator') return;
  const known = db ? (await languagesOf(db, [from.id])).get(from.id) : undefined;
  const lang = known ?? langFrom(from.language_code);
  const title = chat.title ?? (chat.username ? `@${chat.username}` : String(chat.id));
  const lines = [tr(lang, 'vipGroup.added', { title }), '', tr(lang, 'vipGroup.useIt', { id: chat.id })];
  if (chat.type === 'channel' && member.status !== 'administrator') {
    lines.push('', tr(lang, 'vipGroup.channelAdmin'));
  }
  try {
    await telegram.sendMessage(from.id, lines.join('\n'));
  } catch {
    // They never started the bot in private: nothing to do (public groups can use @name).
  }
}
