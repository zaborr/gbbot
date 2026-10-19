import { z } from 'zod';
import { id } from './common.js';

/** A shop the admin can copy products from, with what it has. */
export const cloneSource = z.object({
  id,
  name: z.string(),
  categories: z.array(z.object({ id, title: z.string() })),
  products: z.array(
    z.object({
      id,
      title: z.string(),
      categoryId: id.nullable(),
      isActive: z.boolean(),
      variantCount: z.number().int().nonnegative(),
    }),
  ),
});
export type CloneSource = z.infer<typeof cloneSource>;

export const cloneProductsRequest = z.object({
  sourceShopId: id,
  productIds: z.array(id).min(1).max(1000),
  /** Copy the stock numbers too (otherwise copies are not stock-tracked). */
  copyStock: z.boolean(),
});
export type CloneProductsRequest = z.infer<typeof cloneProductsRequest>;

export const cloneProductsResult = z.object({
  products: z.number().int().nonnegative(),
  categories: z.number().int().nonnegative(),
});
export type CloneProductsResult = z.infer<typeof cloneProductsResult>;
