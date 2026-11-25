import type { LabelRequests } from '@tma-shop/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderLabels, orders, shops, users, type OrderLabelState } from '../db/schema.js';
import { tr, type Lang } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { botToken } from './activeBot.js';
import { withoutBlockedIn } from './blacklist.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { orderLink } from './reminders.js';
import { teamIds, type ShopRow } from './shop.js';

/** What a label may be: a PDF or a picture, up to 10 MB. */
export const MAX_LABEL_BYTES = 10 * 1024 * 1024;
const LABEL_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

type OrderRow = typeof orders.$inferSelect;

const ref = (orderId: string): string => orderId.slice(0, 8);

/** Paid orders whose label has not arrived (optionally of one shipping zone). */
function waitingForLabel(shopId: string, zone: string | null) {
  return and(
    eq(orders.shopId, shopId),
    eq(orders.status, 'paid'),
    isNotNull(orders.userId),
    sql`(${orders.label} IS NULL OR ${orders.label}->>'receivedAt' IS NULL)`,
    zone ? eq(orders.shippingZoneName, zone) : undefined,
  );
}

/** The bot asks the customer for the order's label; the message is kept (a reply to it is the label). */
async function ask(
  db: Database,
  telegram: TelegramApi,
  shop: ShopRow,
  order: OrderRow,
  note: string | null,
  lang: Lang,
  appUrl: string | null,
): Promise<boolean> {
  if (order.userId === null) return false;
  let messageId: number | null = null;
  try {
    const sent = (await telegram.sendMessage(
      order.userId,
      tr(lang, note ? 'label.requestNote' : 'label.request', { shop: shop.name, ref: ref(order.id), note: note ?? '' }),
      appUrl
        ? { inline_keyboard: [[{ text: tr(lang, 'label.uploadButton'), web_app: { url: orderLink(appUrl, shop.slug, order.id) } }]] }
        : undefined,
    )) as { message_id?: number } | true;
    messageId = typeof sent === 'object' ? (sent.message_id ?? null) : null;
  } catch (error) {
    console.warn(`Could not ask for the label of order ${order.id}:`, error instanceof Error ? error.message : error);
    return false;
  }
  const label: OrderLabelState = {
    requestedAt: new Date().toISOString(),
    note,
    messageId,
    // Asked again (a wrong one): waiting until the new one arrives.
    receivedAt: null,
    fileName: order.label?.fileName ?? null,
  };
  await db.update(orders).set({ label, updatedAt: new Date() }).where(eq(orders.id, order.id));
  return true;
}

/** One order: the organisers ask its customer for the shipping label. */
export async function requestLabel(
  db: Database,
  env: Env,
  shop: ShopRow,
  orderId: string,
  note: string | null,
): Promise<{ sent: boolean }> {
  const order = await db.query.orders.findFirst({ where: and(eq(orders.shopId, shop.id), eq(orders.id, orderId)) });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.userId === null || order.status === 'cancelled') {
    throw ApiError.conflict('label_not_askable', 'This order cannot be asked for a label');
  }
  const [allowed] = await withoutBlockedIn(db, env, shop.id, [order.userId]);
  if (allowed === undefined) throw ApiError.conflict('label_not_askable', 'This order cannot be asked for a label');
  const telegram = new TelegramApi(botToken(env));
  const appUrl = await miniAppUrl(telegram).catch(() => null);
  const lang = (await languagesOf(db, [order.userId])).get(order.userId) ?? 'en';
  const sent = await ask(db, telegram, shop, order, note, lang, appUrl);
  if (!sent) throw ApiError.conflict('label_not_sent', 'The bot could not reach this customer');
  return { sent };
}

/** Every paid order still without its label (of a zone, or all): asked, or just counted. */
export async function requestLabels(
  db: Database,
  env: Env,
  shop: ShopRow,
  input: LabelRequests,
): Promise<{ count: number; sent: number }> {
  const rows = await db.select().from(orders).where(waitingForLabel(shop.id, input.zone));
  const ids = [...new Set(rows.map((o) => o.userId!))];
  const allowed = new Set(await withoutBlockedIn(db, env, shop.id, ids));
  const targets = rows.filter((o) => allowed.has(o.userId!));
  if (input.dryRun) return { count: targets.length, sent: 0 };
  const telegram = new TelegramApi(botToken(env));
  const appUrl = await miniAppUrl(telegram).catch(() => null);
  const langs = await languagesOf(db, ids);
  let sent = 0;
  for (const order of targets) {
    if (await ask(db, telegram, shop, order, input.note, langs.get(order.userId!) ?? 'en', appUrl)) sent++;
  }
  return { count: targets.length, sent };
}

/** The label arrives (from the app or a reply to the bot): kept, and sent to the GB's team. */
export async function saveLabel(
  db: Database,
  env: Env,
  orderId: string,
  userId: number,
  file: { mime: string; fileName: string; data: Buffer },
): Promise<void> {
  const order = await db.query.orders.findFirst({ where: and(eq(orders.id, orderId), eq(orders.userId, userId)) });
  if (!order) throw ApiError.notFound('Order not found');
  if (!order.label) throw ApiError.conflict('label_not_asked', 'No shipping label was asked for this order');
  const mime = file.mime.toLowerCase();
  if (!LABEL_TYPES.includes(mime)) throw ApiError.badRequest('bad_label', 'Send a PDF or an image');
  if (file.data.length === 0 || file.data.length > MAX_LABEL_BYTES) {
    throw ApiError.badRequest('label_too_big', 'The file is too big (10 MB at most)');
  }
  const fileName = file.fileName.trim().slice(0, 120) || `label-${ref(order.id)}.${mime === 'application/pdf' ? 'pdf' : 'jpg'}`;
  await db
    .insert(orderLabels)
    .values({ orderId: order.id, mime, fileName, data: file.data, size: file.data.length })
    .onConflictDoUpdate({
      target: orderLabels.orderId,
      set: { mime, fileName, data: file.data, size: file.data.length, createdAt: new Date() },
    });
  const label: OrderLabelState = { ...order.label, receivedAt: new Date().toISOString(), fileName };
  await db.update(orders).set({ label, updatedAt: new Date() }).where(eq(orders.id, order.id));

  // The team gets the file itself.
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, order.shopId) });
  if (!shop) return;
  const team = teamIds(shop);
  const chats = team.length > 0 ? team : env.ADMIN_TELEGRAM_IDS;
  const customer = await db.query.users.findFirst({ where: eq(users.telegramId, userId) });
  const who = customer?.username ? `@${customer.username}` : (customer?.firstName ?? String(userId));
  const langs = await languagesOf(db, chats);
  const telegram = new TelegramApi(botToken(env));
  for (const chat of chats) {
    const caption = tr(langs.get(chat) ?? 'en', 'label.received', { shop: shop.name, ref: ref(order.id), who });
    await telegram
      .sendDocument(chat, fileName, file.data, mime, caption)
      .catch((error: unknown) => console.warn(`Could not send a label to ${chat}:`, error));
  }
}

/** The organisers look at a label (or have the bot send it to them). */
export async function labelFile(
  db: Database,
  shopId: string,
  orderId: string,
): Promise<{ mime: string; fileName: string; data: Buffer }> {
  const [row] = await db
    .select({ mime: orderLabels.mime, fileName: orderLabels.fileName, data: orderLabels.data })
    .from(orderLabels)
    .innerJoin(orders, eq(orderLabels.orderId, orders.id))
    .where(and(eq(orders.shopId, shopId), eq(orders.id, orderId)));
  if (!row) throw ApiError.notFound('No label for this order');
  return row;
}

export async function sendLabelTo(db: Database, env: Env, shop: ShopRow, orderId: string, chatId: number): Promise<void> {
  const file = await labelFile(db, shop.id, orderId);
  await new TelegramApi(botToken(env)).sendDocument(chatId, file.fileName, file.data, file.mime, `${shop.name} · #${ref(orderId)}`);
}

/**
 * A file sent to the bot: the label of an order whose request it answers, or,
 * without a reply, of the only order waiting for one. False: not a label.
 */
export async function handleLabelMessage(
  db: Database,
  env: Env,
  telegram: TelegramApi,
  message: {
    chat?: { id: number };
    from?: { id: number };
    reply_to_message?: { message_id?: number };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string; file_size?: number }>;
  },
  lang: Lang,
): Promise<boolean> {
  const userId = message.from?.id;
  const chatId = message.chat?.id;
  if (userId === undefined || chatId === undefined) return false;
  const photo = message.photo && message.photo.length > 0 ? message.photo[message.photo.length - 1] : undefined;
  const file = message.document
    ? {
        fileId: message.document.file_id,
        mime: message.document.mime_type ?? 'application/octet-stream',
        name: message.document.file_name ?? '',
        size: message.document.file_size ?? 0,
      }
    : photo
      ? { fileId: photo.file_id, mime: 'image/jpeg', name: '', size: photo.file_size ?? 0 }
      : null;
  if (!file) return false;

  const waiting = await db
    .select({ id: orders.id, label: orders.label })
    .from(orders)
    .where(and(eq(orders.userId, userId), sql`${orders.label} IS NOT NULL`, sql`${orders.label}->>'receivedAt' IS NULL`));
  const replyTo = message.reply_to_message?.message_id;
  const order =
    replyTo !== undefined
      ? waiting.find((o) => o.label?.messageId === replyTo)
      : waiting.length === 1
        ? waiting[0]
        : undefined;
  if (!order) {
    // Several waiting and no reply: say how, rather than guess.
    if (replyTo === undefined && waiting.length > 1) {
      await telegram.sendMessage(chatId, tr(lang, 'label.whichOrder'));
      return true;
    }
    return false;
  }
  if (!LABEL_TYPES.includes(file.mime.toLowerCase()) || file.size > MAX_LABEL_BYTES) {
    await telegram.sendMessage(chatId, tr(lang, 'label.badFile'));
    return true;
  }
  try {
    const data = await telegram.downloadFile(file.fileId);
    await saveLabel(db, env, order.id, userId, { mime: file.mime, fileName: file.name, data });
    await telegram.sendMessage(chatId, tr(lang, 'label.thanks', { ref: ref(order.id) }));
  } catch (error) {
    console.error('Could not keep a label:', error);
    await telegram.sendMessage(chatId, tr(lang, 'label.badFile'));
  }
  return true;
}

/** Anonymised orders lose their labels too (they carry the address). */
export async function dropLabels(db: Database, orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  await db.delete(orderLabels).where(inArray(orderLabels.orderId, orderIds));
  await db.update(orders).set({ label: null }).where(inArray(orders.id, orderIds));
}
