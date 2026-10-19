import { and, asc, eq, lt } from 'drizzle-orm';
import { langFrom, type Lang } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { botUploads, shops } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import type { InlineKeyboard, TelegramApi } from '../telegram/api.js';
import type { TelegramUpdate } from '../telegram/types.js';
import { languagesOf } from './notifications.js';
import { canManageShop, isSuperAdmin, teamIds } from './shop.js';
import { isOrganizer } from './team.js';

/**
 * Files sent to the bot: a products CSV or a GB backup (JSON). The bot keeps
 * them for a day and answers with a button that opens the Mini App on the
 * import screen, where the usual preview and confirmations happen.
 */

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Same limit as the import screens. */
const MAX_BYTES = 2_000_000;
/** Buttons offered when someone runs several GBs. */
const MAX_CHOICES = 30;

type Upload = typeof botUploads.$inferSelect;

/** The kind of file, from its name or type. */
export function uploadKind(document: { file_name?: string; mime_type?: string }): 'csv' | 'backup' | null {
  const name = (document.file_name ?? '').toLowerCase();
  const type = (document.mime_type ?? '').toLowerCase();
  if (name.endsWith('.csv') || type === 'text/csv' || type === 'text/comma-separated-values') return 'csv';
  if (name.endsWith('.json') || type === 'application/json') return 'backup';
  return null;
}

/** The Mini App link that opens an upload. */
export function uploadLink(appUrl: string, uploadId: string): string {
  return `${appUrl}${appUrl.includes('?') ? '&' : '?'}upload=${uploadId}`;
}

function openButton(lang: Lang, appUrl: string | null, uploadId: string): InlineKeyboard | undefined {
  return appUrl
    ? { inline_keyboard: [[{ text: tr(lang, 'upload.button'), web_app: { url: uploadLink(appUrl, uploadId) } }]] }
    : undefined;
}

async function langOf(db: Database, userId: number, telegramCode: string | undefined): Promise<Lang> {
  return (await languagesOf(db, [userId])).get(userId) ?? langFrom(telegramCode);
}

/** A document sent to the bot in a private chat. */
export async function handleUploadedFile(
  db: Database,
  env: Env,
  telegram: TelegramApi,
  message: NonNullable<TelegramUpdate['message']>,
  appUrl: string | null,
): Promise<void> {
  const document = message.document;
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  if (!document || chatId === undefined || userId === undefined) return;
  const lang = await langOf(db, userId, message.from?.language_code);
  const reply = (key: Parameters<typeof tr>[1], vars?: Record<string, string | number>, keyboard?: InlineKeyboard) =>
    telegram.sendMessage(chatId, tr(lang, key, vars), keyboard);

  const kind = uploadKind(document);
  if (!kind) return void (await reply('upload.unknownType'));
  if ((document.file_size ?? 0) > MAX_BYTES) return void (await reply('upload.tooBig'));
  const fileName = document.file_name ?? (kind === 'csv' ? 'products.csv' : 'backup.json');

  // Who may use it: a CSV goes into a GB they run; a backup becomes a new GB.
  let choices: Array<{ id: string; name: string }> = [];
  if (kind === 'csv') {
    const rows = await db.select().from(shops).orderBy(asc(shops.sortOrder), asc(shops.createdAt));
    choices = rows
      .filter((s) => teamIds(s).includes(userId))
      .map((s) => ({ id: s.id, name: s.name }));
    // Super-admins run every GB; offer theirs first, else all of them.
    if (choices.length === 0 && isSuperAdmin(env, userId)) {
      choices = rows.map((s) => ({ id: s.id, name: s.name }));
    }
    if (choices.length === 0) return void (await reply('upload.notAllowedCsv'));
  } else if (!isSuperAdmin(env, userId) && !(await isOrganizer(db, userId))) {
    return void (await reply('upload.notAllowedBackup'));
  }

  let content: string;
  try {
    const data = await telegram.downloadFile(document.file_id);
    if (data.length > MAX_BYTES) return void (await reply('upload.tooBig'));
    content = data.toString('utf8');
  } catch (error) {
    console.error('Could not download a file sent to the bot:', error);
    return void (await reply('upload.failed'));
  }

  choices = choices.slice(0, MAX_CHOICES);
  const single = choices.length === 1 ? choices[0] : undefined;
  const [upload] = await db
    .insert(botUploads)
    .values({
      userId,
      kind,
      fileName,
      content,
      shopId: single?.id ?? null,
      shopChoices: choices.map((c) => c.id),
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    })
    .returning();
  if (!upload) throw new Error('Failed to save the upload');

  if (kind === 'backup') {
    await reply('upload.backupReady', { file: fileName }, openButton(lang, appUrl, upload.id));
  } else if (single) {
    await reply('upload.csvReady', { file: fileName, shop: single.name }, openButton(lang, appUrl, upload.id));
  } else {
    await reply('upload.csvPickShop', { file: fileName }, {
      inline_keyboard: choices.map((c, i) => [{ text: c.name, callback_data: `up:${upload.id}:${i}` }]),
    });
  }
}

/** A GB chosen with the buttons for an uploaded CSV. */
export async function handleUploadChoice(
  db: Database,
  env: Env,
  telegram: TelegramApi,
  query: NonNullable<TelegramUpdate['callback_query']>,
  appUrl: string | null,
): Promise<boolean> {
  const match = /^up:([0-9a-f-]{36}):(\d+)$/.exec(query.data ?? '');
  if (!match) return false;
  const lang = await langOf(db, query.from.id, query.from.language_code);
  const upload = await db.query.botUploads.findFirst({ where: eq(botUploads.id, match[1] as string) });
  const shopId = upload?.shopChoices[Number(match[2])];
  const shop = shopId ? await db.query.shops.findFirst({ where: eq(shops.id, shopId) }) : undefined;
  if (!upload || upload.userId !== query.from.id || !shop || upload.expiresAt < new Date()) {
    await telegram.answerCallbackQuery(query.id, tr(lang, 'upload.expired'));
    return true;
  }
  if (!canManageShop(env, shop, query.from.id)) {
    await telegram.answerCallbackQuery(query.id, tr(lang, 'upload.notAllowedCsv'));
    return true;
  }
  await db.update(botUploads).set({ shopId: shop.id }).where(eq(botUploads.id, upload.id));
  await telegram.answerCallbackQuery(query.id);
  if (query.message) {
    await telegram.editMessageText(
      query.message.chat.id,
      query.message.message_id,
      tr(lang, 'upload.csvReady', { file: upload.fileName, shop: shop.name }),
      openButton(lang, appUrl, upload.id),
    );
  }
  return true;
}

/** An upload as the Mini App opens it: only for whoever sent it, while it lasts. */
export async function getUpload(
  db: Database,
  userId: number,
  uploadId: string,
): Promise<{ kind: Upload['kind']; fileName: string; content: string; shopSlug: string | null }> {
  const upload = await db.query.botUploads.findFirst({
    where: and(eq(botUploads.id, uploadId), eq(botUploads.userId, userId)),
  });
  if (!upload || upload.expiresAt < new Date()) {
    throw ApiError.notFound('That file has expired. Send it to the bot again.');
  }
  const shop = upload.shopId
    ? await db.query.shops.findFirst({ where: eq(shops.id, upload.shopId), columns: { slug: true } })
    : undefined;
  return { kind: upload.kind, fileName: upload.fileName, content: upload.content, shopSlug: shop?.slug ?? null };
}

export async function deleteUpload(db: Database, userId: number, uploadId: string): Promise<void> {
  await db.delete(botUploads).where(and(eq(botUploads.id, uploadId), eq(botUploads.userId, userId)));
}

/** Drops files nobody imported within a day. */
export async function deleteExpiredUploads(db: Database, now = new Date()): Promise<number> {
  const rows = await db.delete(botUploads).where(lt(botUploads.expiresAt, now)).returning({ id: botUploads.id });
  return rows.length;
}
