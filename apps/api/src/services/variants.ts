import { asc, inArray } from 'drizzle-orm';
import { unitPriceFor, type ProductOption, type VariantInput } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { productVariants, type products } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

export type VariantRow = typeof productVariants.$inferSelect;
type ProductRow = typeof products.$inferSelect;
/** A Drizzle transaction or the database itself. */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

/** Stable key of a combination: its values in option order. */
export function variantKey(values: readonly string[]): string {
  return values.map((v) => v.trim().toLowerCase()).join('\u0000');
}

/** Variants of several products, grouped by product id and sorted. */
export async function loadVariants(
  db: Executor,
  productIds: readonly string[],
  { activeOnly = false } = {},
): Promise<Map<string, VariantRow[]>> {
  const byProduct = new Map<string, VariantRow[]>();
  if (productIds.length === 0) return byProduct;
  const rows = await db
    .select()
    .from(productVariants)
    .where(inArray(productVariants.productId, [...productIds]))
    .orderBy(asc(productVariants.sortOrder));
  for (const row of rows) {
    if (activeOnly && !row.isActive) continue;
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }
  return byProduct;
}

/** Unit price of one unit of a product (or one of its variants), before quantity tiers. */
export function basePrice(product: ProductRow, variant: VariantRow | null): number {
  return variant?.price ?? product.price;
}

/**
 * Unit price with quantity tiers, where `productQuantity` is how many units of
 * the product (all its variants together) are being bought.
 */
export function tieredPrice(
  product: ProductRow,
  variant: VariantRow | null,
  productQuantity: number,
  /** The buyer (or the order) is VIP: a VIP price, if set, wins over everything. */
  vip = false,
): number {
  return unitPriceFor(
    product.price,
    variant?.price ?? null,
    product.priceTiers,
    productQuantity,
    vip ? (variant?.vipPrice ?? product.vipPrice ?? null) : null,
  );
}

/** Units per product id, summing every line (and variant) of each product. */
export function quantitiesByProduct(
  lines: ReadonlyArray<{ productId: string; quantity: number }>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.quantity);
  }
  return totals;
}

/** Stock that limits a line: the variant's when it has one, else the product's. */
export function lineStock(product: ProductRow, variant: VariantRow | null): number | null {
  return variant ? variant.stock : product.stock;
}

/** Throws unless the options/variants pair is coherent. Returns cleaned options. */
export function validateVariants(
  options: readonly ProductOption[],
  variants: readonly VariantInput[],
): ProductOption[] {
  const cleaned = options.map((o) => ({
    name: o.name.trim(),
    values: o.values.map((v) => v.trim()),
  }));
  const names = new Set(cleaned.map((o) => o.name.toLowerCase()));
  if (names.size !== cleaned.length) {
    throw ApiError.badRequest('invalid_options', 'Option names must be different');
  }
  for (const option of cleaned) {
    if (new Set(option.values.map((v) => v.toLowerCase())).size !== option.values.length) {
      throw ApiError.badRequest('invalid_options', `"${option.name}" has repeated values`);
    }
  }

  if (cleaned.length === 0) {
    if (variants.length > 0) {
      throw ApiError.badRequest('invalid_variants', 'Add options before adding variants');
    }
    return cleaned;
  }
  if (variants.length === 0) {
    throw ApiError.badRequest('invalid_variants', 'A product with options needs at least one variant');
  }

  const seen = new Set<string>();
  for (const variant of variants) {
    if (variant.values.length !== cleaned.length) {
      throw ApiError.badRequest('invalid_variants', 'Each variant needs one value per option');
    }
    variant.values.forEach((value, i) => {
      const option = cleaned[i];
      if (!option?.values.some((v) => v.toLowerCase() === value.trim().toLowerCase())) {
        throw ApiError.badRequest(
          'invalid_variants',
          `"${value}" is not a value of "${option?.name ?? 'option'}"`,
        );
      }
    });
    const key = variantKey(variant.values);
    if (seen.has(key)) {
      throw ApiError.badRequest('invalid_variants', 'The same combination appears twice');
    }
    seen.add(key);
  }
  return cleaned;
}

/**
 * Makes the product's variants match `inputs`: existing combinations keep their
 * id (so carts and orders keep pointing at them), new ones are created and
 * missing ones deleted (cart lines with them go away; past orders keep their
 * snapshot label).
 */
export async function syncVariants(
  db: Executor,
  productId: string,
  inputs: readonly VariantInput[],
): Promise<void> {
  const existing = await db
    .select()
    .from(productVariants)
    .where(inArray(productVariants.productId, [productId]));
  const byKey = new Map(existing.map((row) => [variantKey(row.optionValues), row]));
  const keep = new Set<string>();

  for (const [index, input] of inputs.entries()) {
    const key = variantKey(input.values);
    const values = input.values.map((v) => v.trim());
    const current = byKey.get(key);
    if (current) {
      keep.add(current.id);
      await db
        .update(productVariants)
        .set({
          optionValues: values,
          price: input.price,
          vipPrice: input.vipPrice ?? null,
          stock: input.stock,
          isActive: input.isActive,
          sortOrder: index,
        })
        .where(inArray(productVariants.id, [current.id]));
    } else {
      await db.insert(productVariants).values({
        productId,
        optionValues: values,
        price: input.price,
        vipPrice: input.vipPrice ?? null,
        stock: input.stock,
        isActive: input.isActive,
        sortOrder: index,
      });
    }
  }

  const stale = existing.filter((row) => !keep.has(row.id)).map((row) => row.id);
  if (stale.length > 0) {
    await db.delete(productVariants).where(inArray(productVariants.id, stale));
  }
}
