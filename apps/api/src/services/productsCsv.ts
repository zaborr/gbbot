import type { Category, Lang, ProductsCsvPreview, ProductsCsvResult } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import { readProductsCsv, toSlug, writeProductsCsv, type ParsedProduct } from '../export/productsCsv.js';
import { listCategories } from './catalog.js';
import { createCategory, createProduct, listAllProducts, updateProduct } from './admin.js';
import type { ShopRow } from './shop.js';

/** Existing category for a title written in the file (by title or link name). */
function findCategory(categories: readonly Category[], title: string): Category | undefined {
  const name = title.trim().toLowerCase();
  const slug = toSlug(title);
  return categories.find((c) => c.title.trim().toLowerCase() === name || c.slug === slug);
}

function newCategories(products: readonly ParsedProduct[], categories: readonly Category[]): string[] {
  const titles = new Map<string, string>();
  for (const p of products) {
    if (!p.category || findCategory(categories, p.category)) continue;
    const key = toSlug(p.category) || p.category.toLowerCase();
    if (!titles.has(key)) titles.set(key, p.category.trim());
  }
  return [...titles.values()];
}

async function read(db: Database, shop: ShopRow, csv: string) {
  const [existing, categories] = await Promise.all([
    listAllProducts(db, shop.id),
    listCategories(db, shop.id),
  ]);
  return { ...readProductsCsv(csv, existing, shop.currency), categories };
}

/** What importing the file would do; nothing is saved. */
export async function previewProductsCsv(
  db: Database,
  shop: ShopRow,
  csv: string,
): Promise<ProductsCsvPreview> {
  const { products, errors, categories } = await read(db, shop, csv);
  return {
    products: products.map((p) => ({
      line: p.line,
      slug: p.slug,
      title: p.input.title,
      action: p.existing ? 'update' : 'create',
      variants: p.input.variants.length,
    })),
    newCategories: newCategories(products, categories),
    errors,
  };
}

/**
 * Creates or updates (by link name) the products in the file. Products that
 * are not in it stay as they are. Refused while the file has errors.
 */
export async function importProductsCsv(
  db: Database,
  shop: ShopRow,
  csv: string,
): Promise<ProductsCsvResult> {
  const { products, errors, categories } = await read(db, shop, csv);
  if (errors.length > 0) {
    throw ApiError.badRequest('csv_invalid', 'The file has errors. Check the preview first.');
  }

  const known = [...categories];
  let categoriesCreated = 0;
  for (const title of newCategories(products, known)) {
    const slug = toSlug(title) || `category-${Date.now().toString(36)}`;
    known.push(await createCategory(db, shop.id, { slug, title, sortOrder: known.length }));
    categoriesCreated++;
  }

  let created = 0;
  let updated = 0;
  for (const p of products) {
    const categoryId =
      p.category === undefined
        ? (p.existing?.categoryId ?? null)
        : p.category === null
          ? null
          : (findCategory(known, p.category)?.id ?? null);
    const input = { ...p.input, categoryId };
    if (p.existing) {
      await updateProduct(db, shop.id, p.existing.id, input);
      updated++;
    } else {
      await createProduct(db, shop.id, input);
      created++;
    }
  }
  return { created, updated, categoriesCreated };
}

/** The GB's catalog as a CSV file. */
export async function exportProductsCsv(
  db: Database,
  shop: ShopRow,
  lang: Lang,
): Promise<{ fileName: string; data: Buffer; count: number }> {
  const [products, categories] = await Promise.all([
    listAllProducts(db, shop.id),
    listCategories(db, shop.id),
  ]);
  const date = new Date().toISOString().slice(0, 10);
  return {
    fileName: `${shop.slug}-products-${date}.csv`,
    data: Buffer.from(writeProductsCsv(products, categories, lang), 'utf8'),
    count: products.length,
  };
}
