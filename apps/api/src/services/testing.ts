import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { DONATION_UNIT, tierSteps, unitValue, type TierStep } from '@tma-shop/shared';
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
import { botToken } from './activeBot.js';

/**
 * Collective lab testing of a product or variant (see packages/shared/src/testing.ts).
 * This part sets testings up and shows them; taking part comes with orders.
 */

type TestingRow = typeof testings.$inferSelect;
/** A Drizzle transaction or the database itself. */
type Executor = Pick<Database, 'select'>;
type Writer = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

/**
 * What an order has given to testings and not paid yet, for sums in SQL where
 * `orders` is in the query.
 */
export const donationOfOrder = sql<number>`(select coalesce(sum(di.donation_unpaid * di.unit_price), 0) from order_items di where di.order_id = "orders"."id")`;

/**
 * The money of each testing: fees paid (and what was paid on top of them) on
 * orders paid in full, and the units of what is tested sold in the GB — on
 * every order, fee or not, since the hidden part per unit is the organiser's.
 */
export interface TestingTotals {
  fees: number;
  extras: number;
  payers: number;
  /** Everyone on an order not cancelled, paid or not. */
  entries: number;
  /** Given once the GB closed, on orders paid. */
  donations: number;
  units: number;
  pendingUnits: number;
  orders: number;
}

export async function testingTotals(
  db: Executor,
  testingIds: readonly string[],
): Promise<Map<string, TestingTotals>> {
  const result = new Map<string, TestingTotals>();
  if (testingIds.length === 0) return result;
  const paid = sql`${orders.amountPaid} >= ${orders.total}`;
  const money = await db
    .select({
      testingId: testingEntries.testingId,
      amount: sql<number>`coalesce(sum(case when ${paid} then ${testingEntries.amount} else 0 end), 0)::bigint`,
      extras: sql<number>`coalesce(sum(case when ${paid} then ${testingEntries.extra} else 0 end), 0)::bigint`,
      payers: sql<number>`count(*) filter (where ${paid} and ${testingEntries.amount} > 0)::int`,
      entries: sql<number>`count(*)::int`,
    })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .where(and(inArray(testingEntries.testingId, [...testingIds]), ne(orders.status, 'cancelled')))
    .groupBy(testingEntries.testingId);
  const units = await db
    .select({
      testingId: testings.id,
      units: sql<number>`coalesce(sum(case when ${paid} then ${orderItems.quantity} else 0 end), 0)::int`,
      pendingUnits: sql<number>`coalesce(sum(case when ${paid} then 0 else ${orderItems.quantity} end), 0)::int`,
      orders: sql<number>`count(distinct case when ${paid} then ${orders.id} end)::int`,
    })
    .from(testings)
    .innerJoin(
      orderItems,
      and(
        eq(orderItems.productId, testings.productId),
        sql`(${testings.variantId} is null or ${orderItems.variantId} = ${testings.variantId})`,
      ),
    )
    .innerJoin(orders, and(eq(orderItems.orderId, orders.id), eq(orders.shopId, testings.shopId)))
    .where(and(inArray(testings.id, [...testingIds]), ne(orders.status, 'cancelled')))
    .groupBy(testings.id);
  const given = await db
    .select({
      testingId: testings.id,
      donations: sql<number>`coalesce(sum((${orderItems.quantity} - ${orderItems.donationUnpaid}) * ${orderItems.unitPrice}), 0)::bigint`,
    })
    .from(testings)
    .innerJoin(orderItems, eq(orderItems.productId, testings.donationProductId))
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    // Each gift counts once paid (an order can owe a newer one).
    .where(and(inArray(testings.id, [...testingIds]), ne(orders.status, 'cancelled')))
    .groupBy(testings.id);
  for (const id of testingIds) {
    const m = money.find((r) => r.testingId === id);
    const u = units.find((r) => r.testingId === id);
    const extras = Number(m?.extras ?? 0);
    result.set(id, {
      fees: Number(m?.amount ?? 0) - extras,
      extras,
      payers: Number(m?.payers ?? 0),
      entries: Number(m?.entries ?? 0),
      donations: Number(given.find((r) => r.testingId === id)?.donations ?? 0),
      units: Number(u?.units ?? 0),
      pendingUnits: Number(u?.pendingUnits ?? 0),
      orders: Number(u?.orders ?? 0),
    });
  }
  return result;
}

/** The price of one unit of what each testing tests (what a donor gets back for a vial). */
export async function vialPrices(db: Executor, rows: readonly TestingRow[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (rows.length === 0) return result;
  const productRows = await db
    .select({ id: products.id, price: products.price })
    .from(products)
    .where(inArray(products.id, [...new Set(rows.map((r) => r.productId))]));
  const variantIds = rows.flatMap((r) => (r.variantId ? [r.variantId] : []));
  const variantRows =
    variantIds.length > 0
      ? await db
          .select({ id: productVariants.id, price: productVariants.price })
          .from(productVariants)
          .where(inArray(productVariants.id, variantIds))
      : [];
  for (const row of rows) {
    const base = productRows.find((p) => p.id === row.productId)?.price ?? 0;
    const own = row.variantId ? variantRows.find((v) => v.id === row.variantId)?.price : null;
    result.set(row.id, own ?? base);
  }
  return result;
}

/** The pot: what was paid into the testing and the hidden part of the units sold. */
export const testingPot = (row: Pick<TestingRow, 'perUnit'>, totals: TestingTotals): number =>
  totals.fees + totals.extras + totals.donations + row.perUnit * totals.units;

/** Buyers can give to it now: the GB closed, its time to give not over. */
export const donationsOpen = (row: Pick<TestingRow, 'status' | 'donationsUntil' | 'donationsDone'>, now = new Date()): boolean =>
  row.status === 'closed' && !row.donationsDone && row.donationsUntil !== null && row.donationsUntil > now;

/** Where each tier of a testing stands (fixed by the draw once it is done). */
export function stepsOf(row: TestingRow, totals: TestingTotals, vialPrice: number): TierStep[] {
  const drawn = row.status === 'drawn' || row.status === 'settled';
  return tierSteps({
    tiers: row.tiers,
    pot: testingPot(row, totals),
    vialPrice,
    unitValue: unitValue({
      perUnit: row.perUnit,
      contribution: row.contribution,
      fees: totals.fees,
      units: totals.units,
      orders: totals.orders,
    }),
    done: drawn ? (row.draw?.tiersDone ?? []) : null,
  });
}

/** The tiers a testing's pot covers now, for one testing (loads what it needs). */
export async function reachedTiers(db: Executor, row: TestingRow): Promise<string[]> {
  const totals = (await testingTotals(db, [row.id])).get(row.id);
  const price = (await vialPrices(db, [row])).get(row.id) ?? 0;
  if (!totals) return [];
  return stepsOf({ ...row, status: 'open' }, totals, price)
    .filter((s) => s.reached)
    .map((s) => s.tier.id);
}

/** A VIP does not pay this testing's fee. */
export const feeExempt = (testing: Pick<TestingRow, 'feeMode'>, isVip: boolean): boolean =>
  isVip && testing.feeMode === 'mandatory_non_vip';

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

const EMPTY_TOTALS: TestingTotals = {
  fees: 0,
  extras: 0,
  payers: 0,
  entries: 0,
  donations: 0,
  units: 0,
  pendingUnits: 0,
  orders: 0,
};

function toTestingDTO(
  row: TestingRow,
  productTitle: string,
  label: string | null,
  totals: TestingTotals | undefined,
  vialPrice: number,
  joined: boolean,
  isVip: boolean,
  admin: boolean,
): Testing {
  const t = totals ?? EMPTY_TOTALS;
  const steps = stepsOf(row, t, vialPrice);
  const pot = testingPot(row, t);
  const settled = row.status === 'settled';
  return {
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    productTitle,
    variantLabel: label,
    currency: row.currency,
    lab: row.lab,
    contribution: row.contribution,
    feeMode: row.feeMode,
    // Customers see no money: only how far each tier is.
    tiers: steps.map((step) => ({
      id: step.tier.id,
      name: step.tier.name,
      vials: step.tier.vials,
      reached: step.reached,
      share: step.share,
      unitsLeft: step.unitsLeft,
    })),
    status: row.status as TestingStatus,
    participants: t.payers,
    joined,
    exempt: feeExempt(row, isVip),
    draw: row.draw ?? null,
    reportSentAt: row.report?.sentAt ?? null,
    donationHours: row.donationHours,
    donationsUntil: row.donationsUntil?.toISOString() ?? null,
    donationsOpen: donationsOpen(row),
    donationProductId: row.donationProductId,
    money: admin
      ? {
          perUnit: row.perUnit,
          tiers: row.tiers,
          vialPrice,
          unitValue: Math.round(
            unitValue({
              perUnit: row.perUnit,
              contribution: row.contribution,
              fees: t.fees,
              units: t.units,
              orders: t.orders,
            }),
          ),
          fees: t.fees,
          extras: t.extras,
          perUnitTotal: row.perUnit * t.units,
          donations: t.donations,
          pot,
          units: t.units,
          pendingUnits: t.pendingUnits,
          orders: t.orders,
          payers: t.payers,
          entries: t.entries,
          steps: steps.map((step) => ({
            id: step.tier.id,
            cost: step.cost,
            vialCost: step.vialCost,
            needed: step.needed,
            missing: step.missing,
          })),
          // Once settled, the vials were already given back out of the pot.
          balance:
            pot -
            steps
              .filter((step) => step.reached)
              .reduce((sum, step) => sum + step.cost + (settled ? 0 : step.vialCost), 0),
        }
      : null,
  };
}

/** The shop's testings with their product titles, variant labels and progress. */
async function withLabels(
  db: Database,
  rows: TestingRow[],
  options: { userId?: number | undefined; isVip?: boolean; admin: boolean },
): Promise<Testing[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [totals, joined, prices] = await Promise.all([
    testingTotals(db, ids),
    joinedBy(db, options.userId, ids),
    vialPrices(db, rows),
  ]);
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
      prices.get(row.id) ?? 0,
      joined.has(row.id),
      options.isVip ?? false,
      options.admin,
    ),
  );
}

export async function listTestings(db: Database, shopId: string): Promise<Testing[]> {
  const rows = await db
    .select()
    .from(testings)
    .where(eq(testings.shopId, shopId))
    .orderBy(asc(testings.createdAt));
  return withLabels(db, rows, { admin: true });
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
  isVip = false,
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
  return withLabels(db, rows, { userId, isVip, admin: false });
}

/**
 * For the start screen: per GB (testing on), how many products have an open
 * testing and how many of them have already reached a tier.
 */
export async function shopTestingCounts(
  db: Database,
  shopIds: readonly string[],
): Promise<Map<string, { count: number; reached: number }>> {
  const result = new Map<string, { count: number; reached: number }>();
  if (shopIds.length === 0) return result;
  const rows = await db
    .select({ testing: testings })
    .from(testings)
    .innerJoin(shops, eq(testings.shopId, shops.id))
    .where(and(inArray(testings.shopId, [...shopIds]), eq(testings.status, 'open'), eq(shops.testingEnabled, true)));
  const totals = await testingTotals(
    db,
    rows.map((r) => r.testing.id),
  );
  const prices = await vialPrices(
    db,
    rows.map((r) => r.testing),
  );
  const byShop = new Map<string, { products: Set<string>; reached: Set<string> }>();
  for (const { testing } of rows) {
    const entry = byShop.get(testing.shopId) ?? { products: new Set<string>(), reached: new Set<string>() };
    entry.products.add(testing.productId);
    const steps = stepsOf(testing, totals.get(testing.id) ?? EMPTY_TOTALS, prices.get(testing.id) ?? 0);
    if (steps.some((p) => p.reached)) {
      entry.reached.add(testing.productId);
    }
    byShop.set(testing.shopId, entry);
  }
  for (const [shopId, entry] of byShop) {
    result.set(shopId, { count: entry.products.size, reached: entry.reached.size });
  }
  return result;
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
 * The testings that go with a cart: for each open testing of what the cart
 * holds (this person not in it yet), the fee when it applies — always when
 * mandatory (VIPs exempt in that mode), when ticked when optional — and a VIP
 * exempt only when offering a vial (fee 0).
 */
export async function cartTestingsFor(
  db: Executor,
  shop: ShopRow,
  cartId: string,
  userId: number,
  lines: ReadonlyArray<Line & { label: string }>,
  isVip = false,
): Promise<CartTesting[]> {
  if (!shop.testingEnabled || shop.closedAt || lines.length === 0) return [];
  const open = await db
    .select()
    .from(testings)
    .where(and(eq(testings.shopId, shop.id), eq(testings.status, 'open')));
  if (open.length === 0) return [];
  const ticked = await db.select().from(cartTestings).where(eq(cartTestings.cartId, cartId));
  const joined = await joinedBy(
    db,
    userId,
    open.map((t) => t.id),
  );
  return open.flatMap((testing) => {
    if (joined.has(testing.id)) return [];
    const line = lines.find(
      (l) => l.productId === testing.productId && (testing.variantId === null || l.variantId === testing.variantId),
    );
    if (!line) return [];
    const tick = ticked.find((t) => t.testingId === testing.id);
    const exempt = feeExempt(testing, isVip);
    const pays = !exempt && (testing.feeMode !== 'optional' || tick !== undefined);
    if (!pays && !(exempt && tick?.volunteer)) return [];
    const extra = pays ? (tick?.extra ?? 0) : 0;
    return [
      {
        testingId: testing.id,
        label: line.label,
        amount: pays ? testing.contribution + extra : 0,
        extra,
        volunteer: tick?.volunteer ?? false,
        mandatory: testing.feeMode !== 'optional' && !exempt,
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
  /** Paid on top of the fee; left as it was when not given. */
  extra?: number,
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
    .values({ cartId, testingId, volunteer, extra: extra ?? 0 })
    .onConflictDoUpdate({
      target: [cartTestings.cartId, cartTestings.testingId],
      set: extra === undefined ? { volunteer } : { volunteer, extra },
    });
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
  const [dto] = await withLabels(db, [row], { admin: true });
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
  const variant = input.variantId
    ? await db.query.productVariants.findFirst({ where: eq(productVariants.id, input.variantId) })
    : undefined;
  const what = variant ? `${product.title} · ${variantLabel(variant.optionValues)}` : product.title;
  const whatEn = variant
    ? `${product.titleEn ?? product.title} · ${variantLabel(variant.optionValues)}`
    : (product.titleEn ?? product.title);
  const row = await db.transaction(async (tx) => {
    // What buyers give goes on their orders as lines of a hidden product, 1 a unit.
    const [donation] = await tx
      .insert(products)
      .values({
        shopId: shop.id,
        slug: `donation-${product.slug}-${Math.random().toString(36).slice(2, 8)}`,
        title: `Donación · ${what} (testing)`,
        titleEn: `Donation · ${whatEn} (testing)`,
        price: DONATION_UNIT,
        currency: product.currency,
        isActive: false,
        kind: 'donation',
      })
      .returning({ id: products.id });
    const [created] = await tx
      .insert(testings)
      .values({
        shopId: shop.id,
        productId: product.id,
        variantId: input.variantId,
        currency: product.currency,
        lab: input.lab,
        contribution: input.contribution,
        perUnit: input.perUnit,
        feeMode: input.feeMode,
        tiers: input.tiers,
        donationHours: input.donationHours,
        donationProductId: donation?.id ?? null,
      })
      .returning();
    return created;
  });
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
  // The tiers and the hidden part are the organiser's own sums: they can change
  // until the draw. The fee is what people were charged: it stays once they take part.
  if (current.status !== 'open' && current.status !== 'closed') {
    throw ApiError.conflict('testing_not_open', 'Only an open testing can be changed');
  }
  if (
    (input.contribution !== current.contribution || input.feeMode !== current.feeMode) &&
    (await hasEntries(db, current.id))
  ) {
    throw ApiError.conflict('testing_fee_locked', 'People already paid this fee: it cannot change');
  }
  const [row] = await db
    .update(testings)
    .set({
      lab: input.lab,
      contribution: input.contribution,
      perUnit: input.perUnit,
      feeMode: input.feeMode,
      tiers: input.tiers,
      donationHours: input.donationHours,
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
  const items = await db
    .select({ orderId: orderItems.orderId, quantity: orderItems.quantity, variantId: orderItems.variantId })
    .from(orderItems)
    .where(
      and(
        inArray(
          orderItems.orderId,
          rows.length > 0 ? rows.map((r) => r.order.id) : ['00000000-0000-0000-0000-000000000000'],
        ),
        eq(orderItems.productId, testing.productId),
      ),
    );
  const unitsOf = (orderId: string): number =>
    items
      .filter((i) => i.orderId === orderId && (testing.variantId === null || i.variantId === testing.variantId))
      .reduce((sum, i) => sum + i.quantity, 0);
  const list = rows.map(({ entry, order, user }) => ({
    orderId: order.id,
    name: user?.firstName ?? '—',
    contact: order.contactUsername ?? user?.username ?? null,
    amount: entry.amount,
    extra: entry.extra,
    units: unitsOf(order.id),
    paid: order.amountPaid >= order.total,
    volunteer: entry.volunteer,
    exempt: entry.amount === 0,
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
  await db.transaction(async (tx) => {
    await tx.delete(testings).where(eq(testings.id, current.id));
    // Its donation product goes with it (nobody gave: nobody took part).
    if (current.donationProductId) {
      const [line] = await tx
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(eq(orderItems.productId, current.donationProductId))
        .limit(1);
      if (!line) await tx.delete(products).where(eq(products.id, current.donationProductId));
    }
  });
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
  const prices = await vialPrices(db, rows);
  const labels = await withLabels(db, rows, { admin: false });
  for (const row of rows) {
    const reached = stepsOf(row, totals.get(row.id) ?? EMPTY_TOTALS, prices.get(row.id) ?? 0).filter(
      (p) => p.reached,
    ).length;
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
          sql`${testingEntries.amount} > 0`,
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
    await notifyUsers(db, botToken(env), ids, (lang) =>
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
        sql`${orders.amountPaid} >= ${orders.total} - ${orders.testing} - ${donationOfOrder}`,
        // What is missing is (part of) the testing, not only something given.
        sql`${orders.amountPaid} < ${orders.total} - ${donationOfOrder}`,
      ),
    );
  for (const row of rows) {
    await db.transaction(async (tx) => {
      await tx.delete(testingEntries).where(eq(testingEntries.orderId, row.id));
      await tx
        .update(orders)
        .set({
          total: row.total - row.testing,
          testing: 0,
          status: row.amountPaid >= row.total - row.testing ? 'paid' : 'pending',
          updatedAt: new Date(),
        })
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
    // A VIP exempt from the fee joins only to offer a vial: nothing to pay.
    if (feeExempt(testing, order.isVip)) {
      if (!volunteer) throw ApiError.conflict('testing_exempt', 'As a VIP you do not pay this testing');
      await tx.insert(testingEntries).values({ testingId: testing.id, orderId: order.id, userId, amount: 0, volunteer });
      return;
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
