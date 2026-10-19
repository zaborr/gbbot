import { z } from 'zod';

/**
 * Products as a CSV file: one row per variant (or one row for a product
 * without options); rows with the same `producto` make up one product.
 */
export const PRODUCT_CSV_COLUMNS = [
  // Same blocks as the product form. Columns are read by name, so a file with
  // another order still imports.
  'producto',
  // Text; the English versions (empty = show the Spanish text).
  'titulo',
  'descripcion',
  'titulo_en',
  'descripcion_en',
  // Presentation.
  'imagen',
  'categoria',
  // Price.
  'moneda',
  'precio',
  'precio_vip',
  'escalones',
  // Availability.
  'stock',
  'activo',
  'solo_vip',
  // Variants.
  'opcion1',
  'valor1',
  'opcion2',
  'valor2',
  'opcion3',
  'valor3',
  'precio_variante',
  'precio_vip_variante',
  'stock_variante',
] as const;
export type ProductCsvColumn = (typeof PRODUCT_CSV_COLUMNS)[number];

export const productsCsvRequest = z.object({
  /** The file's text (UTF-8). */
  csv: z.string().min(1).max(2_000_000),
});
export type ProductsCsvRequest = z.infer<typeof productsCsvRequest>;

/** A problem in the file: its line (1 = the header) and what is wrong. */
export const csvIssue = z.object({
  line: z.number().int().positive(),
  /** e.g. `bad_price`; the app shows it in the admin's language. */
  code: z.string(),
  vars: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type CsvIssue = z.infer<typeof csvIssue>;

/** What importing the file would do. Nothing is saved while there are errors. */
export const productsCsvPreview = z.object({
  products: z.array(
    z.object({
      line: z.number().int().positive(),
      slug: z.string(),
      title: z.string(),
      action: z.enum(['create', 'update']),
      variants: z.number().int().nonnegative(),
    }),
  ),
  /** Categories that do not exist yet and will be created. */
  newCategories: z.array(z.string()),
  errors: z.array(csvIssue),
});
export type ProductsCsvPreview = z.infer<typeof productsCsvPreview>;

export const productsCsvResult = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  categoriesCreated: z.number().int().nonnegative(),
});
export type ProductsCsvResult = z.infer<typeof productsCsvResult>;
