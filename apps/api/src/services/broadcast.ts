import { and, desc, eq, gt, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { BroadcastAudience, BroadcastView } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { broadcasts, cartItems, carts, orders } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { TelegramApi, type InlineKeyboard } from '../telegram/api.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { shopLink } from './reminders.js';
import type { ShopRow } from './shop.js';
import { describeUser } from './team.js';

/** Pause between messages: Telegram allows about 30 per second. */
const SEND_GAP_MS = 40;

type BroadcastRow = typeof broadcasts.$inferSelect;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Telegram ids of the GB's buyers in `audience` (anonymised orders have none). */
export async function audienceIds(
  db: Database,
  shopId: string,
  audience: BroadcastAudience,
): Promise<number[]> {
  if (audience === 'cart') {
    const rows = await db
      .selectDistinct({ id: carts.userId })
      .from(carts)
      .innerJoin(cartItems, eq(cartItems.cartId, carts.id))
      .where(eq(carts.shopId, shopId));
    return rows.map((r) => r.id);
  }
  const filters = [eq(orders.shopId, shopId), isNotNull(orders.userId), ne(orders.status, 'cancelled')];
  if (audience === 'paid') {
    filters.push(sql`(${orders.status} IN ('paid', 'shipped', 'fulfilled') OR ${orders.amountPaid} > 0)`);
  } else if (audience === 'unpaid') {
    filters.push(eq(orders.status, 'pending'), gt(sql`${orders.total} - ${orders.amountPaid}`, 0));
  }
  const rows = await db.selectDistinct({ id: orders.userId }).from(orders).where(and(...filters));
  return rows.flatMap((r) => (r.id === null ? [] : [r.id]));
}

async function toView(db: Database, row: BroadcastRow): Promise<BroadcastView> {
  return {
    id: row.id,
    audience: row.audience as BroadcastAudience,
    text: row.text,
    sender: await describeUser(db, row.senderId),
    recipients: row.recipients,
    sent: row.sent,
    failed: row.failed,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The GB's last messages to buyers, newest first. */
export async function listBroadcasts(db: Database, shopId: string): Promise<BroadcastView[]> {
  const rows = await db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.shopId, shopId))
    .orderBy(desc(broadcasts.createdAt))
    .limit(20);
  return Promise.all(rows.map((row) => toView(db, row)));
}

/** "retry after 7" in Telegram's 429 answers. */
function retryAfterMs(error: unknown): number | null {
  const match = /retry after (\d+)/i.exec(error instanceof Error ? error.message : String(error));
  return match ? Number(match[1]) * 1000 : null;
}

/**
 * Sends the message to everyone in the audience, one by one at Telegram's
 * pace, then tells the sender how it went. Runs in the background.
 */
async function deliver(
  db: Database,
  shop: ShopRow,
  row: BroadcastRow,
  ids: readonly number[],
  telegram: TelegramApi,
  gapMs: number,
): Promise<void> {
  const appUrl = await miniAppUrl(telegram);
  const langs = await languagesOf(db, [...ids, row.senderId]);
  let sent = 0;
  let failed = 0;
  for (const [index, chatId] of ids.entries()) {
    const lang = langs.get(chatId) ?? 'en';
    const text = `${tr(lang, 'broadcast.header', { shop: shop.name })}\n\n${row.text}`;
    const keyboard: InlineKeyboard | undefined = appUrl
      ? { inline_keyboard: [[{ text: tr(lang, 'broadcast.button'), web_app: { url: shopLink(appUrl, shop.slug) } }]] }
      : undefined;
    try {
      await telegram.sendMessage(chatId, text, keyboard);
      sent++;
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait !== null) {
        await sleep(wait);
        try {
          await telegram.sendMessage(chatId, text, keyboard);
          sent++;
        } catch {
          failed++;
        }
      } else {
        failed++;
      }
    }
    if ((index + 1) % 25 === 0) {
      await db.update(broadcasts).set({ sent, failed }).where(eq(broadcasts.id, row.id));
    }
    if (gapMs > 0) await sleep(gapMs);
  }
  await db
    .update(broadcasts)
    .set({ sent, failed, status: 'done', finishedAt: new Date() })
    .where(eq(broadcasts.id, row.id));

  const lang = langs.get(row.senderId) ?? 'en';
  const lines = [tr(lang, 'broadcast.done', { shop: shop.name, sent, total: ids.length })];
  if (failed > 0) lines.push(tr(lang, 'broadcast.failedHint', { failed }));
  try {
    await telegram.sendMessage(row.senderId, lines.join('\n'));
  } catch (error) {
    console.error('Could not tell the sender how the broadcast went:', error);
  }
}

/** Records the message and starts sending it; returns at once. */
export async function startBroadcast(
  db: Database,
  env: Env,
  shop: ShopRow,
  senderId: number,
  audience: BroadcastAudience,
  text: string,
  options: { telegram?: TelegramApi; gapMs?: number; wait?: boolean } = {},
): Promise<BroadcastView> {
  const ids = await audienceIds(db, shop.id, audience);
  const [row] = await db
    .insert(broadcasts)
    .values({ shopId: shop.id, senderId, audience, text, recipients: ids.length })
    .returning();
  if (!row) throw new Error('Failed to save the broadcast');
  const run = deliver(
    db,
    shop,
    row,
    ids,
    options.telegram ?? new TelegramApi(env.BOT_TOKEN),
    options.gapMs ?? SEND_GAP_MS,
  ).catch((error: unknown) => console.error(`Broadcast ${row.id} crashed:`, error));
  if (options.wait) await run;
  return toView(db, row);
}

/** A send cut short by a restart: closed so it does not show as "sending" for ever. */
export async function closeStaleBroadcasts(db: Database, now = new Date()): Promise<number> {
  const rows = await db
    .update(broadcasts)
    .set({ status: 'done', finishedAt: now })
    .where(and(eq(broadcasts.status, 'sending'), lt(broadcasts.createdAt, new Date(now.getTime() - 3_600_000))))
    .returning({ id: broadcasts.id });
  return rows.length;
}

