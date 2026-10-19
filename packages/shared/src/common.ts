import { z } from 'zod';

/** Monetary amounts are whole numbers in cents of the token (1290 = 12.90 USDC). */
export const moneyAmount = z.number().int().nonnegative();

/** Token code, e.g. USDC or EURC. */
export const currencyCode = z
  .string()
  .trim()
  .min(3)
  .max(8)
  .regex(/^[A-Z]+$/, 'Currency must be an uppercase code such as USDC');

export const id = z.uuid();

export const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be kebab-case');

export const isoDateTime = z.iso.datetime();

export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(150).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
  });
