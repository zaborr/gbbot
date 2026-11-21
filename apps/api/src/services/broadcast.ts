import { and, desc, eq, gt, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { TESTING_AUDIENCES, type BroadcastAudience, type BroadcastView, type Lang, type ReachResult, type UnreachedPerson } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { broadcasts, cartItems, carts, orders, testingEntries, testings } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { testedLabel } from './testingDraw.js';
import { tr } from '../i18n/messages.js';
import { TelegramApi, type InlineKeyboard } from '../telegram/api.js';
import { miniAppUrl } from './bot.js';
import { languagesOf } from './notifications.js';
import { shopLink } from './reminders.js';
import type { ShopRow } from './shop.js';
import { describeUser, loadPeople } from './team.js';
import { isWebAdminId } from './webAdmins.js';
import { withoutBlocked } from './blacklist.js';
import { botToken } from './activeBot.js';

/** Pause between messages: Telegram allows about 30 per second. */
const SEND_GAP_MS = 40;

type BroadcastRow = typeof broadcasts.$inferSelect;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Telegram ids of the GB's buyers in `audience` (anonymised orders have none). */
export async function audienceIds(
  db: Database,
  env: Env,
  shop: ShopRow,
  audience: BroadcastAudience,
  testingId: string | null = null,
): Promise<number[]> {
  const shopId = shop.id;
  if (TESTING_AUDIENCES.includes(audience)) {
    return withoutBlocked(db, env, shop, await testingAudience(db, shopId, audience, testingId));
  }
  // The blacklisted never hear from the GB.
  if (audience === 'cart') {
    const rows = await db
      .selectDistinct({ id: carts.userId })
      .from(carts)
      .innerJoin(cartItems, eq(cartItems.cartId, carts.id))
      .where(eq(carts.shopId, shopId));
    return withoutBlocked(db, env, shop, rows.map((r) => r.id));
  }
  const filters = [eq(orders.shopId, shopId), isNotNull(orders.userId), ne(orders.status, 'cancelled')];
  if (audience === 'paid') {
    // Orders from outside only took part in a testing: they have their own audience.
    filters.push(
      sql`(${orders.status} IN ('paid', 'shipped', 'fulfilled') OR ${orders.amountPaid} > 0)`,
      eq(orders.external, false),
    );
  } else if (audience === 'unpaid') {
    filters.push(eq(orders.status, 'pending'), gt(sql`${orders.total} - ${orders.amountPaid}`, 0));
  }
  const rows = await db.selectDistinct({ id: orders.userId }).from(orders).where(and(...filters));
  return withoutBlocked(db, env, shop, rows.flatMap((r) => (r.id === null ? [] : [r.id])));
}

/**
 * Those in one testing (from outside too), or its vial donors: the drawn
 * ones once drawn, the volunteers before.
 */
async function testingAudience(
  db: Database,
  shopId: string,
  audience: BroadcastAudience,
  testingId: string | null,
): Promise<number[]> {
  if (!testingId) throw ApiError.badRequest('testing_needed', 'Choose the testing');
  const testing = await db.query.testings.findFirst({
    where: and(eq(testings.shopId, shopId), eq(testings.id, testingId)),
  });
  if (!testing) throw ApiError.notFound('Testing not found');
  const drawn = testing.draw?.hash ? testing.draw : null;
  const donorOrders =
    audience === 'donors' && drawn
      ? drawn.candidates.filter((c) => drawn.donors.includes(c.ref)).map((c) => c.orderId)
      : null;
  if (donorOrders && donorOrders.length === 0) return [];
  const rows = await db
    .selectDistinct({ id: orders.userId })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .where(
      and(
        eq(testingEntries.testingId, testing.id),
        ne(orders.status, 'cancelled'),
        isNotNull(orders.userId),
        audience === 'donors' && !donorOrders ? eq(testingEntries.volunteer, true) : undefined,
        donorOrders ? inArray(orders.id, donorOrders) : undefined,
      ),
    );
  return rows.flatMap((r) => (r.id === null ? [] : [r.id]));
}

/** Who the bot could not reach: their name, @user and last order in the GB. */
export async function describeUnreached(
  db: Database,
  shopId: string,
  ids: readonly number[],
): Promise<UnreachedPerson[]> {
  if (ids.length === 0) return [];
  const people = await loadPeople(db, ids);
  const last = await db
    .selectDistinctOn([orders.userId], { userId: orders.userId, id: orders.id })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), inArray(orders.userId, [...ids])))
    .orderBy(orders.userId, desc(orders.createdAt));
  const refs = new Map(last.map((o) => [o.userId, o.id.slice(0, 8)]));
  return ids.map((id) => {
    const info = people.get(id);
    return {
      telegramId: id,
      name: info?.firstName ?? String(id),
      username: info?.username ?? null,
      orderRef: refs.get(id) ?? null,
    };
  });
}

/** "@ana", or "Ana (order #1a2b3c4d)" for those without a username. */
export function unreachedLabel(lang: Lang, person: UnreachedPerson): string {
  if (person.username) return `@${person.username}`;
  return person.orderRef ? tr(lang, 'broadcast.unreachedOrder', { name: person.name, ref: person.orderRef }) : person.name;
}

/** The list for a bot message: the first 40, then how many more. */
function unreachedList(lang: Lang, people: readonly UnreachedPerson[]): string {
  const shown = people.slice(0, 40).map((p) => unreachedLabel(lang, p));
  const more = people.length - shown.length;
  return more > 0 ? `${shown.join(', ')} ${tr(lang, 'broadcast.unreachedMore', { count: more })}` : shown.join(', ');
}

async function toView(db: Database, row: BroadcastRow): Promise<BroadcastView> {
  const testing = row.testingId
    ? await db.query.testings.findFirst({ where: eq(testings.id, row.testingId) })
    : undefined;
  return {
    id: row.id,
    audience: row.audience as BroadcastAudience,
    testing: testing ? await testedLabel(db, testing) : null,
    text: row.text,
    sender: await describeUser(db, row.senderId),
    recipients: row.recipients,
    sent: row.sent,
    failed: row.failed,
    unreached: await describeUnreached(db, row.shopId, row.failedIds),
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
  const failedIds: number[] = [];
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
          failedIds.push(chatId);
        }
      } else {
        failedIds.push(chatId);
      }
    }
    if ((index + 1) % 25 === 0) {
      await db.update(broadcasts).set({ sent, failed: failedIds.length, failedIds }).where(eq(broadcasts.id, row.id));
    }
    if (gapMs > 0) await sleep(gapMs);
  }
  await db
    .update(broadcasts)
    .set({ sent, failed: failedIds.length, failedIds, status: 'done', finishedAt: new Date() })
    .where(eq(broadcasts.id, row.id));

  const lang = langs.get(row.senderId) ?? 'en';
  const lines = [tr(lang, 'broadcast.done', { shop: shop.name, sent, total: ids.length })];
  if (failedIds.length > 0) {
    lines.push(tr(lang, 'broadcast.failedHint', { failed: failedIds.length }));
    lines.push(unreachedList(lang, await describeUnreached(db, shop.id, failedIds)));
  }
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
  options: { telegram?: TelegramApi; gapMs?: number; wait?: boolean; testingId?: string | null } = {},
): Promise<BroadcastView> {
  const testingId = TESTING_AUDIENCES.includes(audience) ? (options.testingId ?? null) : null;
  const ids = await audienceIds(db, env, shop, audience, testingId);
  const [row] = await db
    .insert(broadcasts)
    .values({ shopId: shop.id, senderId, audience, testingId, text, recipients: ids.length })
    .returning();
  if (!row) throw new Error('Failed to save the broadcast');
  const run = deliver(
    db,
    shop,
    row,
    ids,
    options.telegram ?? new TelegramApi(botToken(env)),
    options.gapMs ?? SEND_GAP_MS,
  ).catch((error: unknown) => console.error(`Broadcast ${row.id} crashed:`, error));
  if (options.wait) await run;
  return toView(db, row);
}

/** A check of who can get messages, while it runs and for an hour after. */
interface ReachCheck {
  shopId: string;
  total: number;
  checked: number;
  unreached: number[];
  done: boolean;
  startedAt: number;
}
const reachChecks = new Map<string, ReachCheck>();

/**
 * Who in an audience the bot cannot write to, without sending them anything:
 * "typing…" for a moment, refused by Telegram for those who never pressed
 * Start or blocked the bot. Runs in the background: the app follows it, and
 * the bot tells the one who asked (not when they use the web).
 */
export async function checkReach(
  db: Database,
  env: Env,
  shop: ShopRow,
  requesterId: number,
  audience: BroadcastAudience,
  options: { telegram?: TelegramApi; gapMs?: number; wait?: boolean; testingId?: string | null } = {},
): Promise<{ id: string; checking: number }> {
  const testingId = TESTING_AUDIENCES.includes(audience) ? (options.testingId ?? null) : null;
  const ids = await audienceIds(db, env, shop, audience, testingId);
  const telegram = options.telegram ?? new TelegramApi(botToken(env));
  const gapMs = options.gapMs ?? SEND_GAP_MS;
  // Old ones go.
  for (const [key, old] of reachChecks) if (Date.now() - old.startedAt > 3_600_000) reachChecks.delete(key);
  const id = crypto.randomUUID();
  const check: ReachCheck = { shopId: shop.id, total: ids.length, checked: 0, unreached: [], done: false, startedAt: Date.now() };
  reachChecks.set(id, check);
  const run = (async () => {
    for (const chatId of ids) {
      try {
        await telegram.sendChatAction(chatId);
      } catch (error) {
        const wait = retryAfterMs(error);
        if (wait === null) check.unreached.push(chatId);
        else {
          await sleep(wait);
          await telegram.sendChatAction(chatId).catch(() => check.unreached.push(chatId));
        }
      }
      check.checked++;
      if (gapMs > 0) await sleep(gapMs);
    }
    check.done = true;
    if (isWebAdminId(requesterId)) return;
    const lang = (await languagesOf(db, [requesterId])).get(requesterId) ?? 'en';
    const lines = [tr(lang, 'broadcast.reachDone', { shop: shop.name, count: check.unreached.length, total: ids.length })];
    if (check.unreached.length > 0) {
      lines.push(unreachedList(lang, await describeUnreached(db, shop.id, check.unreached)));
      lines.push('', tr(lang, 'broadcast.reachHint'));
    }
    await telegram.sendMessage(requesterId, lines.join('\n'));
  })().catch((error: unknown) => {
    check.done = true;
    console.error('Reach check failed:', error);
  });
  if (options.wait) await run;
  return { id, checking: ids.length };
}

/** How a check goes, and who it found so far; null when it is not this GB's or is gone. */
export async function reachStatus(
  db: Database,
  shopId: string,
  id: string,
): Promise<ReachResult | null> {
  const check = reachChecks.get(id);
  if (!check || check.shopId !== shopId) return null;
  return {
    total: check.total,
    checked: check.checked,
    done: check.done,
    unreached: check.done ? await describeUnreached(db, shopId, check.unreached) : [],
  };
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

