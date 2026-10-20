import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { CloneProductsResult, CloneSource } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { categories, productVariants, products, shops } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { canManageShop } from './shop.js';

const SLUG_MAX = 64;

/** `base`, or `base-2`, `base-3`… — the first one not in `taken` (which it then joins). */
export function freeSlug(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

/** Other shops the user manages, with their categories and products, to copy from. */
export async function listCloneSources(
  db: Database,
  env: Env,
  userId: number,
  targetShopId: string,
): Promise<CloneSource[]> {
  const shopRows = (
    await db.select().from(shops).where(ne(shops.id, targetShopId)).orderBy(asc(shops.sortOrder))
  ).filter((shop) => canManageShop(env, shop, userId));
  if (shopRows.length === 0) return [];
  const shopIds = shopRows.map((s) => s.id);
  const [categoryRows, productRows] = await Promise.all([
    db
      .select()
      .from(categories)
      .where(inArray(categories.shopId, shopIds))
      .orderBy(asc(categories.sortOrder), asc(categories.title)),
    db
      .select()
      .from(products)
      .where(inArray(products.shopId, shopIds))
      .orderBy(asc(products.createdAt)),
  ]);
  const variantRows =
    productRows.length === 0
      ? []
      : await db
          .select({ productId: productVariants.productId })
          .from(productVariants)
          .where(
            inArray(
              productVariants.productId,
              productRows.map((p) => p.id),
            ),
          );
  const variantCount = new Map<string, number>();
  for (const v of variantRows) variantCount.set(v.productId, (variantCount.get(v.productId) ?? 0) + 1);

  return shopRows.map((shop) => ({
    id: shop.id,
    name: shop.name,
    categories: categoryRows
      .filter((c) => c.shopId === shop.id)
      .map((c) => ({ id: c.id, title: c.title })),
    products: productRows
      .filter((p) => p.shopId === shop.id)
      .map((p) => ({
        id: p.id,
        title: p.title,
        categoryId: p.categoryId,
        isActive: p.isActive,
        variantCount: variantCount.get(p.id) ?? 0,
      })),
  }));
}

/**
 * Copies products (with their variants, volume prices and categories) from
 * another shop the user manages. Copies arrive hidden, so the admin can review
 * prices and stock before customers see them. Categories are matched by link
 * name and created when missing; product link names get "-2", "-3"… if taken.
 */
export async function cloneProducts(
  db: Database,
  env: Env,
  userId: number,
  targetShopId: string,
  input: { sourceShopId: string; productIds: string[]; copyStock: boolean },
): Promise<CloneProductsResult> {
  if (input.sourceShopId === targetShopId) {
    throw ApiError.badRequest('same_shop', 'Choose another shop to copy from');
  }
  const source = await db.query.shops.findFirst({ where: eq(shops.id, input.sourceShopId) });
  if (!source || !canManageShop(env, source, userId)) throw ApiError.notFound('Shop not found');

  return db.transaction(async (tx) => {
    const sourceProducts = await tx
      .select()
      .from(products)
      .where(and(eq(products.shopId, source.id), inArray(products.id, input.productIds)))
      .orderBy(asc(products.createdAt));
    if (sourceProducts.length === 0) {
      throw ApiError.badRequest('nothing_to_clone', 'Choose at least one product');
    }

    // Categories: reuse the target's by link name, create the missing ones.
    const sourceCategoryIds = [
      ...new Set(sourceProducts.map((p) => p.categoryId).filter((v): v is string => v !== null)),
    ];
    const sourceCategories =
      sourceCategoryIds.length === 0
        ? []
        : await tx.select().from(categories).where(inArray(categories.id, sourceCategoryIds));
    const targetCategories = await tx
      .select()
      .from(categories)
      .where(eq(categories.shopId, targetShopId));
    const bySlug = new Map(targetCategories.map((c) => [c.slug, c.id]));
    const categoryMap = new Map<string, string>();
    let categoriesCreated = 0;
    for (const category of sourceCategories) {
      let targetId = bySlug.get(category.slug);
      if (!targetId) {
        const [created] = await tx
          .insert(categories)
          .values({
            shopId: targetShopId,
            slug: category.slug,
            title: category.title,
            sortOrder: category.sortOrder,
          })
          .returning({ id: categories.id });
        if (!created) throw new Error('Failed to create category');
        targetId = created.id;
        bySlug.set(category.slug, targetId);
        categoriesCreated++;
      }
      categoryMap.set(category.id, targetId);
    }

    const takenSlugs = new Set(
      (
        await tx
          .select({ slug: products.slug })
          .from(products)
          .where(eq(products.shopId, targetShopId))
      ).map((p) => p.slug),
    );
    const variants = await tx
      .select()
      .from(productVariants)
      .where(
        inArray(
          productVariants.productId,
          sourceProducts.map((p) => p.id),
        ),
      )
      .orderBy(asc(productVariants.sortOrder));

    for (const product of sourceProducts) {
      const [copy] = await tx
        .insert(products)
        .values({
          shopId: targetShopId,
          categoryId: product.categoryId ? (categoryMap.get(product.categoryId) ?? null) : null,
          slug: freeSlug(product.slug, takenSlugs),
          title: product.title,
          description: product.description,
          titleEn: product.titleEn,
          descriptionEn: product.descriptionEn,
          price: product.price,
          vipPrice: product.vipPrice,
          currency: product.currency,
          imageUrl: product.imageUrl,
          stock: input.copyStock ? product.stock : null,
          isActive: false,
          vipOnly: product.vipOnly,
          options: product.options,
          priceTiers: product.priceTiers,
        })
        .returning({ id: products.id });
      if (!copy) throw new Error('Failed to copy product');
      const own = variants.filter((v) => v.productId === product.id);
      if (own.length > 0) {
        await tx.insert(productVariants).values(
          own.map((v) => ({
            productId: copy.id,
            optionValues: v.optionValues,
            price: v.price,
            vipPrice: v.vipPrice,
            stock: input.copyStock ? v.stock : null,
            isActive: v.isActive,
            sortOrder: v.sortOrder,
          })),
        );
      }
    }
    return { products: sourceProducts.length, categories: categoriesCreated };
  });
}
