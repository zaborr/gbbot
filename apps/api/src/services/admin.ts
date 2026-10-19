import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { Category, Product, ProductInput } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { categories, orderItems, products } from '../db/schema.js';
import { toCategoryDTO, toProductDTO } from '../db/mappers.js';
import { loadVariants, syncVariants, validateVariants } from './variants.js';
import { ApiError } from '../lib/errors.js';
import { optionalText } from './shop.js';

/** Every product of the shop, hidden ones included (the catalog only shows active). */
export async function listAllProducts(db: Database, shopId: string): Promise<Product[]> {
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.shopId, shopId))
    .orderBy(asc(products.createdAt));
  const variants = await loadVariants(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toProductDTO(row, variants.get(row.id), true));
}

/** Rejects a slug already used by another product of the shop. */
async function assertProductSlugFree(
  db: Database,
  shopId: string,
  slug: string,
  exceptId?: string,
): Promise<void> {
  const filters = [eq(products.shopId, shopId), eq(products.slug, slug)];
  if (exceptId) filters.push(ne(products.id, exceptId));
  const taken = await db.query.products.findFirst({ where: and(...filters) });
  if (taken) {
    throw ApiError.conflict('slug_taken', `A product with the slug "${slug}" already exists`);
  }
}

/** Saves the product row and its variants in one transaction. */
async function saveProduct(
  db: Database,
  shopId: string,
  productId: string | null,
  input: ProductInput,
): Promise<Product> {
  await assertProductSlugFree(db, shopId, input.slug, productId ?? undefined);
  const { variants, ...fields } = input;
  const options = validateVariants(fields.options, variants);
  const values = {
    ...fields,
    titleEn: optionalText(fields.titleEn),
    descriptionEn: optionalText(fields.descriptionEn),
    options,
    // With variants, stock lives on each variant.
    stock: options.length > 0 ? null : fields.stock,
  };

  return db.transaction(async (tx) => {
    const [row] = productId
      ? await tx
          .update(products)
          .set(values)
          .where(and(eq(products.shopId, shopId), eq(products.id, productId)))
          .returning()
      : await tx
          .insert(products)
          .values({ shopId, ...values })
          .returning();
    if (!row) throw ApiError.notFound('Product not found');
    await syncVariants(tx, row.id, options.length > 0 ? variants : []);
    const saved = await loadVariants(tx, [row.id]);
    return toProductDTO(row, saved.get(row.id), true);
  });
}

export async function createProduct(
  db: Database,
  shopId: string,
  input: ProductInput,
): Promise<Product> {
  return saveProduct(db, shopId, null, input);
}

export async function updateProduct(
  db: Database,
  shopId: string,
  productId: string,
  input: ProductInput,
): Promise<Product> {
  return saveProduct(db, shopId, productId, input);
}

/**
 * Removes a product from the shop. Products that already appear in an order
 * cannot be hard-deleted (order history keeps a reference to them), so those
 * are archived instead: hidden from the catalog and no longer purchasable.
 */
export async function deleteProduct(
  db: Database,
  shopId: string,
  productId: string,
): Promise<{ archived: boolean }> {
  const where = and(eq(products.shopId, shopId), eq(products.id, productId));
  const product = await db.query.products.findFirst({ where });
  if (!product) throw ApiError.notFound('Product not found');

  const ordered = await db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.productId, productId))
    .limit(1);

  if (ordered.length > 0) {
    await db.update(products).set({ isActive: false }).where(where);
    return { archived: true };
  }

  await db.delete(products).where(where);
  return { archived: false };
}

/**
 * Removes every product of the shop at once (`confirmCount` must be how many
 * there are, so a stale screen cannot delete more than it showed). Those in
 * some order are hidden instead, like deleting them one by one; categories stay.
 */
export async function deleteAllProducts(
  db: Database,
  shopId: string,
  confirmCount: number,
): Promise<{ deleted: number; archived: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: products.id }).from(products).where(eq(products.shopId, shopId));
    if (rows.length !== confirmCount) {
      throw ApiError.conflict(
        'count_changed',
        'The number of products has changed. Check the catalog and try again.',
      );
    }
    if (rows.length === 0) return { deleted: 0, archived: 0 };
    const ids = rows.map((r) => r.id);
    const ordered = await tx
      .selectDistinct({ id: orderItems.productId })
      .from(orderItems)
      .where(inArray(orderItems.productId, ids));
    const keep = ordered.map((r) => r.id);
    if (keep.length > 0) {
      await tx.update(products).set({ isActive: false }).where(inArray(products.id, keep));
    }
    const remove = ids.filter((id) => !keep.includes(id));
    if (remove.length > 0) await tx.delete(products).where(inArray(products.id, remove));
    return { deleted: remove.length, archived: keep.length };
  });
}

export interface CategoryInput {
  slug: string;
  title: string;
  sortOrder: number;
}

/** Rejects a slug already used by another category of the shop. */
async function assertCategorySlugFree(
  db: Database,
  shopId: string,
  slug: string,
  exceptId?: string,
): Promise<void> {
  const filters = [eq(categories.shopId, shopId), eq(categories.slug, slug)];
  if (exceptId) filters.push(ne(categories.id, exceptId));
  const taken = await db.query.categories.findFirst({ where: and(...filters) });
  if (taken) {
    throw ApiError.conflict('slug_taken', `A category with the slug "${slug}" already exists`);
  }
}

export async function createCategory(
  db: Database,
  shopId: string,
  input: CategoryInput,
): Promise<Category> {
  await assertCategorySlugFree(db, shopId, input.slug);
  const [row] = await db
    .insert(categories)
    .values({ shopId, ...input })
    .returning();
  if (!row) throw new Error('Failed to create category');
  return toCategoryDTO(row);
}

export async function updateCategory(
  db: Database,
  shopId: string,
  categoryId: string,
  input: CategoryInput,
): Promise<Category> {
  await assertCategorySlugFree(db, shopId, input.slug, categoryId);
  const [row] = await db
    .update(categories)
    .set({ ...input })
    .where(and(eq(categories.shopId, shopId), eq(categories.id, categoryId)))
    .returning();
  if (!row) throw ApiError.notFound('Category not found');
  return toCategoryDTO(row);
}

/** Deletes a category; its products stay in the shop without a category. */
export async function deleteCategory(
  db: Database,
  shopId: string,
  categoryId: string,
): Promise<void> {
  const deleted = await db
    .delete(categories)
    .where(and(eq(categories.shopId, shopId), eq(categories.id, categoryId)))
    .returning({ id: categories.id });
  if (deleted.length === 0) throw ApiError.notFound('Category not found');
}
