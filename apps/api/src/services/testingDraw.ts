import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  isSaleStatus,
  settleDraw,
  type DrawCandidate,
  type Lang,
  type OrderStatus,
  type TestingDraw,
} from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orderItems, orders, productVariants, products, shops, testingEntries, testings } from '../db/schema.js';
import { variantLabel } from '../db/mappers.js';
import { tr } from '../i18n/messages.js';
import { ApiError } from '../lib/errors.js';
import { withoutBlocked } from './blacklist.js';
import { notifyUsers } from './notifications.js';
import type { ShopRow } from './shop.js';
import { botToken } from './activeBot.js';
import { donationsOpen, reachedTiers } from './testing.js';
import { closeDonationWindows, donationsBeingChecked } from './testingDonations.js';

/**
 * The draw of donors for a testing: the organiser launches it once the GB is
 * closed and every fee paid; the next Bitcoin block decides it. Candidates are
 * those who paid the fee (and VIPs exempt from it who offered a vial);
 * volunteers come first. Each candidate's place comes from
 * sha256(block hash + short order id), so anyone can check it.
 */

type TestingRow = typeof testings.$inferSelect;

/** Public explorers for the chain tip and the block hash (the first that answers). */
const EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];

async function explorer(path: string, fetchImpl: typeof fetch): Promise<string> {
  let last: unknown = null;
  for (const base of EXPLORERS) {
    try {
      const res = await fetchImpl(`${base}${path}`, { headers: { 'user-agent': 'gb-bot' } });
      if (res.ok) return (await res.text()).trim();
      last = new Error(`${base} ${res.status}`);
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error('No block explorer answered');
}

export const shortRef = (orderId: string): string => orderId.slice(0, 8);

/** A candidate's place in the draw: lower comes first. */
export function drawScore(blockHash: string, ref: string): string {
  return createHash('sha256').update(`${blockHash}${ref}`).digest('hex');
}

/** Volunteers first, then the rest; each group by its score. */
export function rankCandidates(blockHash: string, candidates: readonly DrawCandidate[]): DrawCandidate[] {
  const byScore = (list: DrawCandidate[]): DrawCandidate[] =>
    list
      .map((c) => ({ c, score: drawScore(blockHash, c.ref) }))
      .sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0))
      .map((x) => x.c);
  return [...byScore(candidates.filter((c) => c.volunteer)), ...byScore(candidates.filter((c) => !c.volunteer))];
}

async function findTesting(db: Database, shopId: string, id: string): Promise<TestingRow> {
  const row = await db.query.testings.findFirst({ where: and(eq(testings.shopId, shopId), eq(testings.id, id)) });
  if (!row) throw ApiError.notFound('Testing not found');
  return row;
}

/** Entries whose order is not paid in full yet (nor cancelled). */
async function unpaidEntries(db: Database, testingId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .where(
      and(
        eq(testingEntries.testingId, testingId),
        ne(orders.status, 'cancelled'),
        sql`${testingEntries.amount} > 0`,
        sql`${orders.amountPaid} < ${orders.total}`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Why the draw cannot be launched yet, or null. */
export async function drawBlocker(db: Database, shop: ShopRow, testing: TestingRow): Promise<string | null> {
  if (!shop.closedAt) return 'gb_open';
  if (testing.status !== 'closed') return 'not_closed';
  if (donationsOpen(testing)) return 'donations_open';
  if ((await unpaidEntries(db, testing.id)) > 0) return 'unpaid';
  if (await donationsBeingChecked(db, testing)) return 'unpaid';
  return null;
}

/**
 * Who can be drawn: those who paid the fee (their order paid in full), and VIPs
 * exempt from it who offered a vial. One place per person, blacklisted
 * customers left out. Each with the price of one unit of what is tested on
 * their order: what a donor gets back.
 */
async function loadCandidates(db: Database, env: Env, shop: ShopRow, testing: TestingRow): Promise<DrawCandidate[]> {
  const entries = await db
    .select({ entry: testingEntries, order: orders })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .where(and(eq(testingEntries.testingId, testing.id), ne(orders.status, 'cancelled')))
    .orderBy(asc(testingEntries.createdAt));
  const orderIds = entries.map((e) => e.order.id);
  const items =
    orderIds.length > 0
      ? await db
          .select({ orderId: orderItems.orderId, unitPrice: orderItems.unitPrice, variantId: orderItems.variantId })
          .from(orderItems)
          .where(and(inArray(orderItems.orderId, orderIds), eq(orderItems.productId, testing.productId)))
      : [];
  const priceOf = (orderId: string): number =>
    items.find((i) => i.orderId === orderId && (testing.variantId === null || i.variantId === testing.variantId))
      ?.unitPrice ?? 0;

  const people = new Map<number, DrawCandidate>();
  for (const { entry, order } of entries) {
    if (order.userId === null || order.amountPaid < order.total || people.has(order.userId)) continue;
    // Exempt (fee 0): only as a volunteer.
    if (entry.amount <= 0 && !entry.volunteer) continue;
    people.set(order.userId, {
      orderId: order.id,
      ref: shortRef(order.id),
      volunteer: entry.volunteer,
      vialPrice: priceOf(order.id),
    });
  }
  const allowed = new Set(await withoutBlocked(db, env, shop, [...people.keys()]));
  return [...people.entries()].filter(([userId]) => allowed.has(userId)).map(([, c]) => c);
}

/** What is tested, for messages and the "−1 vial" marks. */
export async function testedLabel(db: Database, testing: TestingRow): Promise<string> {
  const product = await db.query.products.findFirst({ where: eq(products.id, testing.productId) });
  const variant = testing.variantId
    ? await db.query.productVariants.findFirst({ where: eq(productVariants.id, testing.variantId) })
    : undefined;
  const title = product?.title ?? '';
  return variant ? `${title} · ${variantLabel(variant.optionValues)}` : title;
}

/** Telegram ids of the candidates and participants (who hear about the draw). */
export async function audience(
  db: Database,
  env: Env,
  shop: ShopRow,
  orderIds: readonly string[],
): Promise<number[]> {
  if (orderIds.length === 0) return [];
  const rows = await db
    .select({ userId: orders.userId })
    .from(orders)
    .where(inArray(orders.id, [...orderIds]));
  const ids = [...new Set(rows.flatMap((r) => (r.userId === null ? [] : [r.userId])))];
  return withoutBlocked(db, env, shop, ids);
}

/**
 * Launches the draw: the candidates are fixed and the next block (tip + 1)
 * will decide it. With no vials needed it is done at once.
 */
export async function launchDraw(
  db: Database,
  env: Env,
  shop: ShopRow,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TestingRow> {
  const testing = await findTesting(db, shop.id, id);
  const blocker = await drawBlocker(db, shop, testing);
  if (blocker === 'gb_open') throw ApiError.conflict('draw_gb_open', 'Close the GB before the draw');
  if (blocker === 'not_closed') throw ApiError.conflict('draw_done', 'This testing was already drawn');
  if (blocker === 'unpaid') throw ApiError.conflict('draw_unpaid', 'Some contributions are not paid yet');
  if (blocker === 'donations_open') {
    throw ApiError.conflict('draw_donations_open', 'Buyers can still give: wait until that time is over');
  }

  const candidates = await loadCandidates(db, env, shop, testing);
  const tip = Number(await explorer('/blocks/tip/height', fetchImpl));
  if (!Number.isInteger(tip) || tip <= 0) throw new Error('Bad block height');
  const draw: TestingDraw = {
    height: tip + 1,
    hash: null,
    announcedAt: new Date().toISOString(),
    drawnAt: null,
    candidates,
    ranking: [],
    donors: [],
    tiersDone: [],
    history: testing.draw?.history ?? [],
  };
  const [row] = await db
    .update(testings)
    .set({ status: 'drawing', draw, updatedAt: new Date() })
    .where(and(eq(testings.id, testing.id), eq(testings.status, 'closed')))
    .returning();
  if (!row) throw ApiError.conflict('draw_done', 'This testing was already drawn');

  const what = await testedLabel(db, testing);
  const ids = await audience(
    db,
    env,
    shop,
    candidates.map((c) => c.orderId),
  );
  const refs = candidates.map((c) => `#${c.ref}${c.volunteer ? ' 🙋' : ''}`).join(', ');
  await notifyUsers(db, botToken(env), ids, (lang: Lang) =>
    tr(lang, 'testing.drawAnnounced', {
      shop: shop.name,
      product: what,
      height: draw.height,
      candidates: refs || '—',
    }),
  );
  return row;
}

/** Completes the draw once its block is mined: ranking, donors, tiers, "−1 vial" marks. */
export async function finishDraw(
  db: Database,
  env: Env,
  testing: TestingRow,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const draw = testing.draw;
  if (testing.status !== 'drawing' || !draw) return false;
  let hash: string;
  try {
    hash = await explorer(`/block-height/${draw.height}`, fetchImpl);
  } catch {
    return false; // Not mined yet (or the explorers are down): try again later.
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) return false;

  const shop = await db.query.shops.findFirst({ where: eq(shops.id, testing.shopId) });
  if (!shop) return false;
  const reached = await reachedTiers(db, testing);
  const ranked = rankCandidates(hash, draw.candidates);
  const { tiersDone, donors } = settleDraw(testing.tiers, reached, ranked);
  const done: TestingDraw = {
    ...draw,
    hash,
    drawnAt: new Date().toISOString(),
    ranking: ranked.map((c) => c.ref),
    donors,
    tiersDone,
  };
  const what = await testedLabel(db, testing);
  const donorOrders = ranked.filter((c) => donors.includes(c.ref)).map((c) => c.orderId);

  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(testings)
      .set({ status: 'drawn', draw: done, updatedAt: new Date() })
      .where(and(eq(testings.id, testing.id), eq(testings.status, 'drawing')))
      .returning({ id: testings.id });
    if (!row) return false;
    if (donorOrders.length > 0) {
      await tx
        .update(orders)
        .set({ donatedVials: sql`${orders.donatedVials} || ${JSON.stringify([what])}::jsonb` })
        .where(inArray(orders.id, donorOrders));
    }
    return true;
  });
  if (!claimed) return false;

  const tierNames = testing.tiers.filter((t) => tiersDone.includes(t.id)).map((t) => t.name);
  const ids = await audience(
    db,
    env,
    shop,
    draw.candidates.map((c) => c.orderId),
  );
  const donorIds = new Set(await audience(db, env, shop, donorOrders));
  const link = `https://mempool.space/block/${hash}`;
  await notifyUsers(
    db,
    botToken(env),
    ids.filter((id) => !donorIds.has(id)),
    (lang) =>
      tr(lang, 'testing.drawResult', {
        shop: shop.name,
        product: what,
        height: draw.height,
        donors: donors.map((r) => `#${r}`).join(', ') || '—',
        tiers: tierNames.join(', ') || '—',
        link,
      }),
  );
  await notifyUsers(db, botToken(env), [...donorIds], (lang) =>
    tr(lang, 'testing.drawDonor', { shop: shop.name, product: what, height: draw.height, link }),
  );
  return true;
}

/** Checks the draws waiting for their block (every minute while the server runs). */
export async function watchDraws(db: Database, env: Env): Promise<void> {
  try {
    await closeDonationWindows(db, env);
  } catch (error) {
    console.error('Closing the time to give failed:', error);
  }
  const waiting = await db.select().from(testings).where(eq(testings.status, 'drawing'));
  for (const testing of waiting) {
    try {
      await finishDraw(db, env, testing);
    } catch (error) {
      console.error(`Draw of testing ${testing.id} failed:`, error);
    }
  }
}

export function scheduleDrawWatcher(db: Database, env: Env): void {
  setInterval(() => void watchDraws(db, env), 60 * 1000).unref();
}

/**
 * A donor's order was cancelled after the draw: the next one in the same
 * ranking (whose order is still on) donates instead.
 */
export async function substituteDonor(
  db: Database,
  env: Env,
  shop: ShopRow,
  id: string,
  ref: string,
): Promise<TestingRow> {
  const testing = await findTesting(db, shop.id, id);
  const draw = testing.draw;
  if (testing.status !== 'drawn' || !draw?.hash || !draw.donors.includes(ref)) {
    throw ApiError.conflict('draw_no_donor', 'That order is not a donor of this testing');
  }
  const byRef = new Map(draw.candidates.map((c) => [c.ref, c]));
  const live = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(inArray(orders.id, draw.candidates.map((c) => c.orderId)));
  const on = new Set(live.filter((o) => isSaleStatus(o.status as OrderStatus)).map((o) => o.id));
  const next = draw.ranking.find((r) => !draw.donors.includes(r) && on.has(byRef.get(r)?.orderId ?? ''));
  if (!next) throw ApiError.conflict('draw_no_substitute', 'Nobody else can donate');

  const what = await testedLabel(db, testing);
  const out = byRef.get(ref);
  const inn = byRef.get(next);
  const donors = draw.donors.map((r) => (r === ref ? next : r));
  const [row] = await db.transaction(async (tx) => {
    if (out) {
      await tx
        .update(orders)
        .set({ donatedVials: sql`${orders.donatedVials} - ${what}::text` })
        .where(eq(orders.id, out.orderId));
    }
    if (inn) {
      await tx
        .update(orders)
        .set({ donatedVials: sql`${orders.donatedVials} || ${JSON.stringify([what])}::jsonb` })
        .where(eq(orders.id, inn.orderId));
    }
    return tx
      .update(testings)
      .set({ draw: { ...draw, donors }, updatedAt: new Date() })
      .where(eq(testings.id, testing.id))
      .returning();
  });
  if (!row) throw ApiError.notFound('Testing not found');
  if (inn) {
    const ids = await audience(db, env, shop, [inn.orderId]);
    const link = `https://mempool.space/block/${draw.hash}`;
    await notifyUsers(db, botToken(env), ids, (lang) =>
      tr(lang, 'testing.drawDonor', { shop: shop.name, product: what, height: draw.height, link }),
    );
  }
  return row;
}

/**
 * The GB is opened again: a draw not settled yet is cancelled (kept in its
 * history, and everyone told), its "−1 vial" marks go and the testing opens.
 */
export async function cancelDrawsOnReopen(db: Database, env: Env, shop: ShopRow): Promise<void> {
  const rows = await db
    .select()
    .from(testings)
    .where(and(eq(testings.shopId, shop.id), inArray(testings.status, ['drawing', 'drawn'])));
  for (const testing of rows) {
    const draw = testing.draw;
    if (!draw) continue;
    const what = await testedLabel(db, testing);
    const donorOrders = draw.candidates.filter((c) => draw.donors.includes(c.ref)).map((c) => c.orderId);
    await db.transaction(async (tx) => {
      if (donorOrders.length > 0) {
        await tx
          .update(orders)
          .set({ donatedVials: sql`${orders.donatedVials} - ${what}::text` })
          .where(inArray(orders.id, donorOrders));
      }
      await tx
        .update(testings)
        .set({
          status: 'open',
          draw: {
            ...draw,
            history: [
              ...(draw.history ?? []),
              { height: draw.height, hash: draw.hash, donors: draw.donors, cancelledAt: new Date().toISOString() },
            ],
          },
          updatedAt: new Date(),
        })
        .where(eq(testings.id, testing.id));
    });
    const ids = await audience(
      db,
      env,
      shop,
      draw.candidates.map((c) => c.orderId),
    );
    await notifyUsers(db, botToken(env), ids, (lang) =>
      tr(lang, 'testing.drawCancelled', { shop: shop.name, product: what }),
    );
  }
}
