import { z } from 'zod';
import { currencyCode, id, isoDateTime, moneyAmount, paginationQuery, slug } from './common.js';
import { priceTiers } from './pricing.js';

export const category = z.object({
  id,
  shopId: id,
  slug,
  title: z.string().min(1).max(128),
  sortOrder: z.number().int(),
});
export type Category = z.infer<typeof category>;

/** An option group, e.g. `{ name: 'Color', values: ['Red', 'Blue'] }`. */
export const productOption = z.object({
  name: z.string().trim().min(1).max(32),
  values: z.array(z.string().trim().min(1).max(32)).min(1).max(30),
});
export type ProductOption = z.infer<typeof productOption>;

/**
 * One combination of option values (e.g. Red / M). It can have its own price
 * and stock; without a price it costs the product's price.
 */
export const productVariant = z.object({
  id,
  /** One value per option, in the product's option order. */
  values: z.array(z.string()),
  /** "Red / M" */
  label: z.string(),
  /** Own price in minor units, or null to use the product's price. */
  priceOverride: moneyAmount.nullable(),
  /** Effective unit price for one unit (before quantity tiers). */
  price: moneyAmount,
  /** Own VIP price, or null to use the product's (only sent to VIPs and admins). */
  vipPriceOverride: moneyAmount.nullable(),
  /** VIP price of this variant (own, else the product's); null = none, or not for this user. */
  vipPrice: moneyAmount.nullable(),
  /** `null` = not stock-tracked. */
  stock: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
});
export type ProductVariant = z.infer<typeof productVariant>;

/** A variant as the admin saves it; existing ones are matched by their values. */
export const variantInput = z.object({
  values: z.array(z.string().trim().min(1).max(32)).min(1).max(3),
  price: moneyAmount.nullable(),
  /** Own VIP price; null = the product's VIP price. */
  vipPrice: moneyAmount.nullable().default(null),
  stock: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
});
export type VariantInput = z.infer<typeof variantInput>;

export const product = z.object({
  id,
  shopId: id,
  categoryId: id.nullable(),
  slug,
  /** Spanish (the main text). */
  title: z.string().min(1).max(256),
  description: z.string().max(4096),
  /** English version for apps not in Spanish; null = show the Spanish one. */
  titleEn: z.string().max(256).nullable(),
  descriptionEn: z.string().max(4096).nullable(),
  /** Price in cents of the token (1290 = 12.90 USDC). */
  price: moneyAmount,
  /**
   * Fixed price for the GB's VIPs (no quantity tiers): they always pay it.
   * Only sent to VIPs and admins; null otherwise or when there is none.
   */
  vipPrice: moneyAmount.nullable(),
  currency: currencyCode,
  imageUrl: z.url().nullable(),
  /** `null` means the product is not stock-tracked (always available). Unused with variants. */
  stock: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
  /** Only the GB's VIPs see it and can buy it (admins see it too). */
  vipOnly: z.boolean(),
  /** Option groups (max 3). Empty for a product without variants. */
  options: z.array(productOption).max(3),
  /** Every combination of the options (admins also see inactive ones). */
  variants: z.array(productVariant),
  /** Quantity breaks on the product's price; empty = same price for any quantity. */
  priceTiers,
  createdAt: isoDateTime,
});
export type Product = z.infer<typeof product>;

export const catalogQuery = paginationQuery.extend({
  categoryId: id.optional(),
  search: z.string().trim().min(1).max(128).optional(),
});
export type CatalogQuery = z.infer<typeof catalogQuery>;

/** Payload accepted by the admin product create/update endpoints. */
export const productInput = product
  .omit({ id: true, shopId: true, createdAt: true, variants: true })
  .extend({
    /** Required when `options` is not empty: the combinations to sell. */
    variants: z.array(variantInput).max(200),
    vipPrice: moneyAmount.nullable().default(null),
    vipOnly: z.boolean().default(false),
    titleEn: z.string().trim().max(256).nullable().default(null),
    descriptionEn: z.string().trim().max(4096).nullable().default(null),
  });
export type ProductInput = z.infer<typeof productInput>;
