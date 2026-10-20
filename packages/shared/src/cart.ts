import { z } from 'zod';
import { currencyCode, id, moneyAmount } from './common.js';
import { product, productVariant } from './catalog.js';

export const cartItemInput = z.object({
  productId: id,
  /** Required for products with variants. */
  variantId: id.nullable().optional(),
  quantity: z.number().int().positive().max(999),
});
export type CartItemInput = z.infer<typeof cartItemInput>;

/** A cart line resolved against the current catalog, with computed subtotal. */
export const cartLine = z.object({
  /** Cart line id (use it to change the quantity or remove the line). */
  id,
  product,
  variant: productVariant.nullable(),
  /** Unit price for this line at its current quantity. */
  unitPrice: moneyAmount,
  quantity: z.number().int().positive(),
  subtotal: moneyAmount,
});
export type CartLine = z.infer<typeof cartLine>;

export const cart = z.object({
  lines: z.array(cartLine),
  currency: currencyCode,
  /** Per-order fee included in `total` (0 when the cart is empty or no fee is set). */
  fee: moneyAmount,
  total: moneyAmount,
  /** The buyer is a VIP of this GB: VIP prices (and maybe no fee) apply. */
  isVip: z.boolean(),
  itemCount: z.number().int().nonnegative(),
});
export type Cart = z.infer<typeof cart>;
