import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { tierProgress } from '@tma-shop/shared';
import type {
  CartTesting,
  TestingParticipant,
  CreateTestingRequest,
  ShopAdminView,
  Testing,
  TestingStatus,
  UpdateTestingRequest,
} from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import {
  cartTestings,
  orderItems,
  orders,
  productVariants,
  products,
  shops,
  testingEntries,
  testings,
  users,
} from '../db/schema.js';
import { toShopAdminDTO, variantLabel } from '../db/mappers.js';
import { ApiError } from '../lib/errors.js';
import type { Env } from '../config/env.js';
import { tr } from '../i18n/messages.js';
import { notifyUsers } from './notifications.js';
import { withoutBlocked } from './blacklist.js';
import type { ShopRow } from './shop.js';

/**
 * Collective lab testing of a product or variant (see packages/shared/src/testing.ts).
 * This part sets testings up and shows them; taking part comes with orders.
 */

type TestingRow = typeof testings.$inferSelect;
/** A Drizzle transaction or the database itself. */
type Executor = Pick<Database, 'select'>;
type Writer = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

/** Money raised for each testing: an entry counts once its whole order is paid. */
export interface TestingTotals {
  raised: number;
  pending: number;
  participants: number;
}

export async function testingTotals(
  db: Executor,
  testingIds: readonly string[],
): Promise<Map<string, TestingTotals>> {
  const result = new Map<string, TestingTotals>();
  if (testingIds.length === 0) return result;
  const paid = sql`${orders.amountPaid} >= ${orders.total}`;
  const rows = await db
    .select({
      testingId: testingEntries.testingId,
      raised: sql<number>`coalesce(sum(case when ${paid} then ${testingEntries.amount} else 0 end), 0)::bigint`,
      pending: sql<number>`coalesce(sum(case when ${paid} then 0 else ${testingEntries.amount} end), 0)::bigint`,
      participants: sql<number>`count(*) filter (where ${paid})::int`,
    })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .where(and(inArray(testingEntries.testingId, [...testingIds]), ne(orders.status, 'cancelled')))
    .groupBy(testingEntries.testingId);
  for (const row of rows) {
    result.set(row.testingId, {
      raised: Number(row.raised),
      pending: Number(row.pending),
      participants: Number(row.participants),
    });
  }
  return result;
}

/** The testings this person already takes part in (on an order not cancelled). */
async function joinedBy(db: Executor, userId: number | undefined, testingIds: readonly string[]): Promise<Set<string>> {
  if (userId === undefined || testingIds.length === 0) return new Set();
  const rows = await db
    .select({ testingId: testingEntries.testingId })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .where(
      and(
        inArray(testingEntries.testingId, [...testingIds]),
        eq(testingEntries.userId, userId),
        ne(orders.status, 'cancelled'),
      ),
    );
  return new Set(rows.map((r) => r.testingId));
}

/** Testings still running: they keep the product, variant and switch as they are. */
const FINISHED: TestingStatus[] = ['settled', 'cancelled'];

function toTestingDTO(
  row: TestingRow,
  productTitle: string,
  label: string | null,
  totals: TestingTotals | undefined,
  joined: boolean,
): Testing {
  return {
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    productTitle,
    variantLabel: label,
    currency: row.currency,
    lab: row.lab,
    contribution: row.contribution,
    refundThreshold: row.refundThreshold,
    tiers: row.tiers,
    status: row.status as TestingStatus,
    raised: totals?.raised ?? 0,
    participants: totals?.participants ?? 0,
    pending: totals?.pending ?? 0,
    joined,
    draw: row.draw ?? null,
  };
}

/** The shop's testings with their product titles, variant labels and money raised. */
async function withLabels(db: Database, rows: TestingRow[], userId?: number): Promise<Testing[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [totals, joined] = await Promise.all([testingTotals(db, ids), joinedBy(db, userId, ids)]);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const variantIds = rows.flatMap((r) => (r.variantId ? [r.variantId] : []));
  const [productRows, variantRows] = await Promise.all([
    db
      .select({ id: products.id, title: products.title })
      .from(products)
      .where(inArray(products.id, productIds)),
    variantIds.length > 0
      ? db.select().from(productVariants).where(inArray(productVariants.id, variantIds))
      : Promise.resolve([]),
  ]);
  const titles = new Map(productRows.map((p) => [p.id, p.title]));
  const labels = new Map(variantRows.map((v) => [v.id, variantLabel(v.optionValues)]));
  return rows.map((row) =>
    toTestingDTO(
      row,
      titles.get(row.productId) ?? '',
      row.variantId ? (labels.get(row.variantId) ?? null) : null,
      totals.get(row.id),
      joined.has(row.id),
    ),
  );
}

export async function listTestings(db: Database, shopId: string): Promise<Testing[]> {
  const rows = await db
    .select()
    .from(testings)
    .where(eq(testings.shopId, shopId))
    .orderBy(asc(testings.createdAt));
  return withLabels(db, rows);
}

/**
 * The testings customers see (all of the GB's, or one product's): those not
 * cancelled, while the GB has testing on.
 */
export async function listVisibleTestings(
  db: Database,
  shop: ShopRow,
  userId: number | undefined,
  productId?: string,
): Promise<Testing[]> {
  if (!shop.testingEnabled) return [];
  const rows = await db
    .select()
    .from(testings)
    .where(
      and(
        eq(testings.shopId, shop.id),
        productId ? eq(testings.productId, productId) : undefined,
        notInArray(testings.status, ['cancelled']),
      ),
    )
    .orderBy(asc(testings.createdAt));
  return withLabels(db, rows, userId);
}

/** Whether a GB has a testing people can join now (start screen). */
export async function shopsWithOpenTesting(db: Database, shopIds: readonly string[]): Promise<Set<string>> {
  if (shopIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ shopId: testings.shopId })
    .from(testings)
    .innerJoin(shops, eq(testings.shopId, shops.id))
    .where(and(inArray(testings.shopId, [...shopIds]), eq(testings.status, 'open'), eq(shops.testingEnabled, true)));
  return new Set(rows.map((r) => r.shopId));
}

/** A line (product, variant) as the cart and the order hold it. */
interface Line {
  productId: string;
  variantId: string | null;
}

const covers = (testing: Pick<TestingRow, 'productId' | 'variantId'>, lines: readonly Line[]): boolean =>
  lines.some(
    (l) => l.productId === testing.productId && (testing.variantId === null || l.variantId === testing.variantId),
  );

/**
 * The testings ticked in a cart that still apply: the GB has testing on and is
 * open, the testing is open, the cart holds what it tests, and this person is
 * not in it already.
 */
export async function cartTestingsFor(
  db: Executor,
  shop: ShopRow,
  cartId: string,
  userId: number,
  lines: ReadonlyArray<Line & { label: string }>,
): Promise<CartTesting[]> {
  if (!shop.testingEnabled || shop.closedAt) return [];
  const rows = await db
    .select({ ticked: cartTestings, testing: testings })
    .from(cartTestings)
    .innerJoin(testings, eq(cartTestings.testingId, testings.id))
    .where(eq(cartTestings.cartId, cartId));
  if (rows.length === 0) return [];
  const joined = await joinedBy(
    db,
    userId,
    rows.map((r) => r.testing.id),
  );
  return rows.flatMap(({ ticked, testing }) => {
    if (testing.shopId !== shop.id || testing.status !== 'open' || joined.has(testing.id)) return [];
    const line = lines.find(
      (l) => l.productId === testing.productId && (testing.variantId === null || l.variantId === testing.variantId),
    );
    if (!line) return [];
    return [
      {
        testingId: testing.id,
        label: line.label,
        amount: testing.contribution,
        volunteer: ticked.volunteer,
      },
    ];
  });
}

/** Ticks (or updates) a testing in the cart; the cart must hold what it tests. */
export async function tickCartTesting(
  db: Database,
  shop: ShopRow,
  cartId: string,
  userId: number,
  testingId: string,
  volunteer: boolean,
  lines: readonly Line[],
): Promise<void> {
  if (!shop.testingEnabled) {
    throw ApiError.conflict('testing_off', 'Turn on product testing in the GB settings first');
  }
  const testing = await db.query.testings.findFirst({
    where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)),
  });
  if (!testing) throw ApiError.notFound('Testing not found');
  if (testing.status !== 'open') throw ApiError.conflict('testing_not_open', 'This testing is closed');
  if (!covers(testing, lines)) {
    throw ApiError.conflict('testing_needs_product', 'Add the tested product to the cart first');
  }
  if ((await joinedBy(db, userId, [testing.id])).size > 0) {
    throw ApiError.conflict('testing_joined', 'You already take part in this testing');
  }
  await db
    .insert(cartTestings)
    .values({ cartId, testingId, volunteer })
    .onConflictDoUpdate({ target: [cartTestings.cartId, cartTestings.testingId], set: { volunteer } });
}

export async function untickCartTesting(db: Database, cartId: string, testingId: string): Promise<void> {
  await db
    .delete(cartTestings)
    .where(and(eq(cartTestings.cartId, cartId), eq(cartTestings.testingId, testingId)));
}

/**
 * What an order's testings add once its lines become `lines`: entries whose
 * product or variant is no longer on it drop out (removed when `apply`).
 */
export async function testingAfterChange(
  tx: Writer,
  orderId: string,
  lines: readonly Line[],
  apply: boolean,
): Promise<number> {
  const rows = await tx
    .select({ entry: testingEntries, testing: testings })
    .from(testingEntries)
    .innerJoin(testings, eq(testingEntries.testingId, testings.id))
    .where(eq(testingEntries.orderId, orderId));
  const gone = rows.filter((r) => !covers(r.testing, lines)).map((r) => r.entry.id);
  if (apply && gone.length > 0) {
    await tx.delete(testingEntries).where(inArray(testingEntries.id, gone));
  }
  return rows.filter((r) => !gone.includes(r.entry.id)).reduce((sum, r) => sum + r.entry.amount, 0);
}



async function findTesting(db: Database, shopId: string, id: string): Promise<TestingRow> {
  const row = await db.query.testings.findFirst({
    where: and(eq(testings.shopId, shopId), eq(testings.id, id)),
  });
  if (!row) throw ApiError.notFound('Testing not found');
  return row;
}

async function oneTesting(db: Database, row: TestingRow): Promise<Testing> {
  const [dto] = await withLabels(db, [row]);
  if (!dto) throw ApiError.notFound('Testing not found');
  return dto;
}

export async function createTesting(
  db: Database,
  shop: ShopRow,
  input: CreateTestingRequest,
): Promise<Testing> {
  if (!shop.testingEnabled) {
    throw ApiError.conflict('testing_off', 'Turn on product testing in the GB settings first');
  }
  const product = await db.query.products.findFirst({
    where: and(eq(products.shopId, shop.id), eq(products.id, input.productId)),
  });
  if (!product) throw ApiError.notFound('Product not found');
  if (product.options.length > 0) {
    if (!input.variantId) throw ApiError.badRequest('variant_required', 'Choose the variant to test');
    const variant = await db.query.productVariants.findFirst({
      where: and(eq(productVariants.productId, product.id), eq(productVariants.id, input.variantId)),
    });
    if (!variant) throw ApiError.notFound('Variant not found');
  } else if (input.variantId) {
    throw ApiError.badRequest('no_variants', 'This product has no variants');
  }
  const taken = await db.query.testings.findFirst({
    where: and(
      eq(testings.productId, product.id),
      input.variantId ? eq(testings.variantId, input.variantId) : isNull(testings.variantId),
    ),
  });
  if (taken) {
    throw ApiError.conflict('testing_exists', 'This product or variant already has a testing');
  }
  const [row] = await db
    .insert(testings)
    .values({
      shopId: shop.id,
      productId: product.id,
      variantId: input.variantId,
      currency: product.currency,
      lab: input.lab,
      contribution: input.contribution,
      refundThreshold: input.refundThreshold,
      tiers: input.tiers,
    })
    .returning();
  if (!row) throw new Error('Failed to create the testing');
  return oneTesting(db, row);
}

export async function updateTesting(
  db: Database,
  shopId: string,
  id: string,
  input: UpdateTestingRequest,
): Promise<Testing> {
  const current = await findTesting(db, shopId, id);
  if (current.status !== 'open') {
    throw ApiError.conflict('testing_not_open', 'Only an open testing can be changed');
  }
  // Once people take part, what they signed up for stays: same contribution,
  // same tiers in the same order (new ones can be added at the end).
  if (await hasEntries(db, current.id)) {
    const kept = input.tiers.slice(0, current.tiers.length);
    const same =
      input.contribution === current.contribution &&
      kept.length === current.tiers.length &&
      current.tiers.every(
        (tier, i) => kept[i]?.id === tier.id && kept[i]?.cost === tier.cost && kept[i]?.vials === tier.vials,
      );
    if (!same) {
      throw ApiError.conflict(
        'testing_joined_by_others',
        'People already take part: only new tiers can be added at the end',
      );
    }
  }
  const [row] = await db
    .update(testings)
    .set({
      lab: input.lab,
      contribution: input.contribution,
      refundThreshold: input.refundThreshold,
      tiers: input.tiers,
      updatedAt: new Date(),
    })
    .where(eq(testings.id, current.id))
    .returning();
  if (!row) throw ApiError.notFound('Testing not found');
  return oneTesting(db, row);
}

async function hasEntries(db: Executor, testingId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: testingEntries.id })
    .from(testingEntries)
    .where(eq(testingEntries.testingId, testingId))
    .limit(1);
  return row !== undefined;
}

/** Who takes part, for the organiser (paid first, then waiting for payment). */
export async function listParticipants(
  db: Database,
  shopId: string,
  id: string,
): Promise<TestingParticipant[]> {
  const testing = await findTesting(db, shopId, id);
  const rows = await db
    .select({ entry: testingEntries, order: orders, user: users })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .leftJoin(users, eq(testingEntries.userId, users.telegramId))
    .where(and(eq(testingEntries.testingId, testing.id), ne(orders.status, 'cancelled')))
    .orderBy(asc(testingEntries.createdAt));
  const list = rows.map(({ entry, order, user }) => ({
    orderId: order.id,
    name: user?.firstName ?? '—',
    contact: order.contactUsername ?? user?.username ?? null,
    amount: entry.amount,
    paid: order.amountPaid >= order.total,
    volunteer: entry.volunteer,
  }));
  return [...list.filter((p) => p.paid), ...list.filter((p) => !p.paid)];
}

/** Removes a testing nobody has taken part in yet. */
export async function deleteTesting(db: Database, shopId: string, id: string): Promise<void> {
  const current = await findTesting(db, shopId, id);
  if (current.status !== 'open' && current.status !== 'cancelled') {
    throw ApiError.conflict('testing_not_open', 'Only an open testing can be changed');
  }
  if (await hasEntries(db, current.id)) {
    throw ApiError.conflict('testing_has_entries', 'People already take part in this testing');
  }
  await db.delete(testings).where(eq(testings.id, current.id));
}

/** Turning testing on or off for the GB; off only once its testings are finished. */
export async function setTestingEnabled(
  db: Database,
  shopId: string,
  enabled: boolean,
): Promise<ShopAdminView> {
  if (!enabled) {
    const running = await db.query.testings.findFirst({
      where: and(eq(testings.shopId, shopId), notInArray(testings.status, FINISHED)),
    });
    if (running) {
      throw ApiError.conflict('testing_running', 'Finish or delete the testings of this GB first');
    }
  }
  const [row] = await db
    .update(shops)
    .set({ testingEnabled: enabled })
    .where(eq(shops.id, shopId))
    .returning();
  if (!row) throw ApiError.notFound('Shop not found');
  return toShopAdminDTO(row);
}

/**
 * A product change that would leave a testing without what it tests: another
 * token, variants added to a product tested as a whole, or the tested variant
 * removed (checked where variants are synced).
 */
export async function assertProductKeepsTestings(
  db: Executor,
  productId: string,
  currency: string,
  withVariants: boolean,
): Promise<void> {
  const rows = await db.select().from(testings).where(eq(testings.productId, productId));
  for (const row of rows) {
    if (row.currency !== currency) {
      throw ApiError.conflict('testing_currency', 'This product has a testing: its token cannot change');
    }
    if ((row.variantId === null) === withVariants) {
      throw ApiError.conflict(
        'testing_variants',
        'This product has a testing: its variants cannot change that way',
      );
    }
  }
}

/** Rejects removing variants that a testing is about. */
export async function assertVariantsFreeOfTestings(
  db: Executor,
  variantIds: readonly string[],
): Promise<void> {
  if (variantIds.length === 0) return;
  const [row] = await db
    .select({ id: testings.id })
    .from(testings)
    .where(inArray(testings.variantId, [...variantIds]))
    .limit(1);
  if (row) {
    throw ApiError.conflict('testing_variant', 'A variant with a testing cannot be removed');
  }
}

/**
 * After a payment is confirmed: each testing of the GB that now covers more
 * tiers tells its paid participants (each tier once).
 */
export async function announceTestingTiers(db: Database, env: Env, shopId: string): Promise<void> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop?.testingEnabled) return;
  const rows = await db
    .select()
    .from(testings)
    .where(and(eq(testings.shopId, shop.id), inArray(testings.status, ['open', 'closed'])));
  if (rows.length === 0) return;
  const totals = await testingTotals(
    db,
    rows.map((r) => r.id),
  );
  const labels = await withLabels(db, rows);
  for (const row of rows) {
    const raised = totals.get(row.id)?.raised ?? 0;
    const reached = tierProgress(row.tiers, raised, row.contribution).filter((p) => p.reached).length;
    if (reached <= row.notifiedTiers) continue;
    // Claim it first, so two payments at once do not announce it twice.
    const claimed = await db
      .update(testings)
      .set({ notifiedTiers: reached })
      .where(and(eq(testings.id, row.id), sql`${testings.notifiedTiers} < ${reached}`))
      .returning({ id: testings.id });
    if (claimed.length === 0) continue;

    const people = await db
      .select({ userId: testingEntries.userId })
      .from(testingEntries)
      .innerJoin(orders, eq(testingEntries.orderId, orders.id))
      .where(
        and(
          eq(testingEntries.testingId, row.id),
          ne(orders.status, 'cancelled'),
          sql`${orders.amountPaid} >= ${orders.total}`,
        ),
      );
    const ids = await withoutBlocked(
      db,
      env,
      shop,
      people.flatMap((p) => (p.userId === null ? [] : [p.userId])),
    );
    const dto = labels.find((l) => l.id === row.id);
    const what = dto?.variantLabel ? `${dto.productTitle} · ${dto.variantLabel}` : (dto?.productTitle ?? '');
    const newly = row.tiers.slice(row.notifiedTiers, reached).map((tier) => tier.name).join(', ');
    await notifyUsers(db, env.BOT_TOKEN, ids, (lang) =>
      tr(lang, 'testing.tierReached', { shop: shop.name, product: what, tiers: newly }),
    );
  }
}

/**
 * Once the GB is closed nobody can pay for a testing any more: an order whose
 * products are paid but not its testing drops the testing and is paid again.
 * `orderId` limits it to one order (a payment rejected after closing).
 */
export async function dropUnpaidTesting(db: Database, shopId: string, orderId?: string): Promise<number> {
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.shopId, shopId),
        orderId ? eq(orders.id, orderId) : undefined,
        eq(orders.status, 'pending'),
        eq(orders.amountSubmitted, 0),
        sql`${orders.testing} > 0`,
        sql`${orders.amountPaid} > 0`,
        sql`${orders.amountPaid} >= ${orders.total} - ${orders.testing}`,
        sql`${orders.amountPaid} < ${orders.total}`,
      ),
    );
  for (const row of rows) {
    await db.transaction(async (tx) => {
      await tx.delete(testingEntries).where(eq(testingEntries.orderId, row.id));
      await tx
        .update(orders)
        .set({ total: row.total - row.testing, testing: 0, status: 'paid', updatedAt: new Date() })
        .where(eq(orders.id, row.id));
    });
  }
  return rows.length;
}

/**
 * Joins a testing with an order already placed (paid, or not paid yet): its
 * contribution is added to the order, which then waits for that payment.
 */
export async function joinTestingWithOrder(
  db: Database,
  shop: ShopRow,
  userId: number,
  orderId: string,
  testingId: string,
  volunteer: boolean,
): Promise<void> {
  if (!shop.testingEnabled) {
    throw ApiError.conflict('testing_off', 'Turn on product testing in the GB settings first');
  }
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.shopId, shop.id), eq(orders.id, orderId), eq(orders.userId, userId)))
      .for('update');
    if (!order) throw ApiError.notFound('Order not found');
    // Not while a payment is being checked: its amount would not match any more.
    if (order.status !== 'paid' && !(order.status === 'pending' && order.amountSubmitted === 0)) {
      throw ApiError.conflict('testing_order_state', 'A testing cannot be added to this order now');
    }
    const testing = await tx.query.testings.findFirst({
      where: and(eq(testings.shopId, shop.id), eq(testings.id, testingId)),
    });
    if (!testing) throw ApiError.notFound('Testing not found');
    if (testing.status !== 'open') throw ApiError.conflict('testing_not_open', 'This testing is closed');
    if (testing.currency !== order.currency) {
      throw ApiError.conflict('mixed_currency', `This order is in ${order.currency}`);
    }
    const items = await tx
      .select({ productId: orderItems.productId, variantId: orderItems.variantId })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    if (!covers(testing, items)) {
      throw ApiError.conflict('testing_needs_product', 'This order does not have the tested product');
    }
    if ((await joinedBy(tx, userId, [testing.id])).size > 0) {
      throw ApiError.conflict('testing_joined', 'You already take part in this testing');
    }
    await tx.insert(testingEntries).values({
      testingId: testing.id,
      orderId: order.id,
      userId,
      amount: testing.contribution,
      volunteer,
    });
    await tx
      .update(orders)
      .set({
        testing: order.testing + testing.contribution,
        total: order.total + testing.contribution,
        // Paid already: back to waiting for the difference (the testing).
        status: 'pending',
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));
  });
}
