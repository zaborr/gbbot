import { z } from 'zod';
import { moneyAmount } from './common.js';

/**
 * A quantity break: from `minQty` units of the product (all its variants
 * together), one unit of the product costs `price`.
 */
export const priceTier = z.object({
  minQty: z.number().int().min(2).max(100_000),
  price: moneyAmount,
});
export type PriceTier = z.infer<typeof priceTier>;

/** Tiers sorted by quantity, with strictly increasing quantities. */
export const priceTiers = z
  .array(priceTier)
  .max(10)
  .transform((tiers) => [...tiers].sort((a, b) => a.minQty - b.minQty))
  .refine(
    (tiers) => tiers.every((tier, i) => i === 0 || tier.minQty > (tiers[i - 1]?.minQty ?? 0)),
    'Each tier needs a different quantity',
  );

/** The tier that applies to `quantity` units, if any. */
export function tierFor(tiers: readonly PriceTier[], quantity: number): PriceTier | null {
  let match: PriceTier | null = null;
  for (const tier of tiers) {
    if (quantity >= tier.minQty && (!match || tier.minQty > match.minQty)) match = tier;
  }
  return match;
}

/**
 * Unit price of a product (or one of its variants) when `productQuantity`
 * units of that product are bought. Tiers are set on the product's price; a
 * variant with its own price keeps its difference (base 10, XL 12, tier 7 →
 * XL 9). Never below 0.
 */
export function unitPriceFor(
  productPrice: number,
  variantPrice: number | null,
  tiers: readonly PriceTier[],
  productQuantity: number,
  /** The VIP price that applies (a VIP buying something with one): fixed, no tiers. */
  vipPrice: number | null = null,
): number {
  if (vipPrice !== null) return vipPrice;
  const base = variantPrice ?? productPrice;
  const tier = tierFor(tiers, productQuantity);
  if (!tier) return base;
  return Math.max(0, base + (tier.price - productPrice));
}
