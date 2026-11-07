import { and, asc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type {
  CreateTestingRequest,
  ShopAdminView,
  Testing,
  TestingStatus,
  UpdateTestingRequest,
} from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { productVariants, products, shops, testings } from '../db/schema.js';
import { toShopAdminDTO, variantLabel } from '../db/mappers.js';
import { ApiError } from '../lib/errors.js';
import type { ShopRow } from './shop.js';

/**
 * Collective lab testing of a product or variant (see packages/shared/src/testing.ts).
 * This part sets testings up and shows them; taking part comes with orders.
 */

type TestingRow = typeof testings.$inferSelect;
/** A Drizzle transaction or the database itself. */
type Executor = Pick<Database, 'select'>;

/** Testings still running: they keep the product, variant and switch as they are. */
const FINISHED: TestingStatus[] = ['settled', 'cancelled'];

function toTestingDTO(
  row: TestingRow,
  productTitle: string,
  label: string | null,
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
    // Taking part (and so the money raised) comes with orders.
    raised: 0,
    participants: 0,
    pending: 0,
  };
}

/** The shop's testings with their product titles and variant labels. */
async function withLabels(db: Database, rows: TestingRow[]): Promise<Testing[]> {
  if (rows.length === 0) return [];
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
 * The testings a customer sees on a product page. For now only the team sees
 * them (a preview), until taking part arrives.
 */
export async function listProductTestings(
  db: Database,
  shop: ShopRow,
  productId: string,
  canManage: boolean,
): Promise<Testing[]> {
  if (!shop.testingEnabled || !canManage) return [];
  const rows = await db
    .select()
    .from(testings)
    .where(
      and(
        eq(testings.shopId, shop.id),
        eq(testings.productId, productId),
        notInArray(testings.status, ['cancelled']),
      ),
    )
    .orderBy(asc(testings.createdAt));
  return withLabels(db, rows);
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

/** Removes a testing nobody has taken part in yet. */
export async function deleteTesting(db: Database, shopId: string, id: string): Promise<void> {
  const current = await findTesting(db, shopId, id);
  if (current.status !== 'open' && current.status !== 'cancelled') {
    throw ApiError.conflict('testing_not_open', 'Only an open testing can be changed');
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
