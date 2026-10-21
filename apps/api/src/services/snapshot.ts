import { asc, eq, inArray } from 'drizzle-orm';
import { EMPTY_VIP_CLUB, type GbSnapshot } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { categories, productVariants, products, shops } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { assertSlugFree, nextSortOrder, parseAddressKey, type ShopRow } from './shop.js';

/**
 * A GB's settings and catalog, without orders, customers or admins: what is
 * copied when duplicating it, and what goes into its JSON backup.
 */
export async function takeSnapshot(db: Database, shop: ShopRow): Promise<GbSnapshot> {
  const [categoryRows, productRows] = await Promise.all([
    db
      .select()
      .from(categories)
      .where(eq(categories.shopId, shop.id))
      .orderBy(asc(categories.sortOrder), asc(categories.title)),
    db.select().from(products).where(eq(products.shopId, shop.id)).orderBy(asc(products.createdAt)),
  ]);
  const variantRows =
    productRows.length === 0
      ? []
      : await db
          .select()
          .from(productVariants)
          .where(
            inArray(
              productVariants.productId,
              productRows.map((p) => p.id),
            ),
          )
          .orderBy(asc(productVariants.sortOrder));
  const categorySlug = new Map(categoryRows.map((c) => [c.id, c.slug]));

  return {
    format: 'tma-gb',
    version: 1,
    exportedAt: new Date().toISOString(),
    shop: {
      name: shop.name,
      slug: shop.slug,
      description: shop.description,
      nameEn: shop.nameEn,
      descriptionEn: shop.descriptionEn,
      imageUrl: shop.imageUrl,
      vipOnly: shop.vipOnly,
      currency: shop.currency,
      orderFee: shop.orderFee,
      orderFeeLabel: shop.orderFeeLabel,
      vipNoFee: shop.vipNoFee,
      vipNoShipping: shop.vipNoShipping,
      autoCancelHours: shop.autoCancelHours,
      closingWarnHours: shop.closingWarnHours,
      shippingZones: shop.shippingZones,
      paymentSetup: shop.paymentSetup,
      addressPublicKey: shop.addressPublicKey,
      vipClub: shop.vipClub ?? EMPTY_VIP_CLUB,
      useGlobalVipClub: shop.useGlobalVipClub,
      disclaimer: shop.disclaimerVersion > 0 ? shop.disclaimer : null,
      goalAmount: shop.goalAmount,
      goalShowAmount: shop.goalShowAmount,
    },
    categories: categoryRows.map((c) => ({ slug: c.slug, title: c.title, sortOrder: c.sortOrder })),
    products: productRows.map((p) => ({
      slug: p.slug,
      category: p.categoryId ? (categorySlug.get(p.categoryId) ?? null) : null,
      title: p.title,
      description: p.description,
      titleEn: p.titleEn,
      descriptionEn: p.descriptionEn,
      price: p.price,
      vipPrice: p.vipPrice,
      currency: p.currency,
      imageUrl: p.imageUrl,
      stock: p.stock,
      isActive: p.isActive,
      vipOnly: p.vipOnly,
      minQuantity: p.minQuantity,
      options: p.options,
      priceTiers: p.priceTiers,
      variants: variantRows
        .filter((v) => v.productId === p.id)
        .map((v) => ({
          values: v.optionValues,
          price: v.price,
          vipPrice: v.vipPrice,
          stock: v.stock,
          isActive: v.isActive,
        })),
    })),
  };
}

/**
 * Creates a new GB from a snapshot: hidden, with `ownerId` as its only
 * administrator to start with, never closed. All or nothing.
 */
export async function restoreSnapshot(
  db: Database,
  snapshot: GbSnapshot,
  target: { name: string; slug: string; ownerId: number },
): Promise<ShopRow> {
  await assertSlugFree(db, target.slug);
  const s = snapshot.shop;
  // The key is checked again: a backup file may have been edited by hand.
  const key = s.addressPublicKey ? parseAddressKey(s.addressPublicKey) : null;
  const sortOrder = await nextSortOrder(db);

  return db.transaction(async (tx) => {
    const [shop] = await tx
      .insert(shops)
      .values({
        name: target.name,
        slug: target.slug,
        description: s.description,
        nameEn: s.nameEn,
        descriptionEn: s.descriptionEn,
        imageUrl: s.imageUrl,
        isVisible: false,
        vipOnly: s.vipOnly,
        sortOrder,
        closingWarnHours: s.closingWarnHours,
        vipClub: s.vipClub,
        useGlobalVipClub: s.useGlobalVipClub,
        ownerIds: [target.ownerId],
        paymentSetup: s.paymentSetup,
        currency: s.currency,
        orderFee: s.orderFee,
        orderFeeLabel: s.orderFeeLabel,
        vipNoFee: s.vipNoFee,
        vipNoShipping: s.vipNoShipping,
        autoCancelHours: s.autoCancelHours,
        shippingZones: s.shippingZones,
        addressPublicKey: key?.base64 ?? null,
        addressKeyFingerprint: key?.fingerprint ?? null,
        disclaimer: s.disclaimer,
        disclaimerVersion: s.disclaimer ? 1 : 0,
        goalAmount: s.goalAmount,
        goalShowAmount: s.goalShowAmount,
      })
      .returning();
    if (!shop) throw new Error('Failed to create shop');

    const categoryIds = new Map<string, string>();
    for (const category of snapshot.categories) {
      if (categoryIds.has(category.slug)) continue;
      const [row] = await tx
        .insert(categories)
        .values({ shopId: shop.id, ...category })
        .returning({ id: categories.id });
      if (!row) throw new Error('Failed to create category');
      categoryIds.set(category.slug, row.id);
    }

    const seen = new Set<string>();
    for (const product of snapshot.products) {
      if (seen.has(product.slug)) {
        throw ApiError.badRequest('duplicate_product', `Two products have the link name "${product.slug}"`);
      }
      seen.add(product.slug);
      const { variants, category, ...fields } = product;
      const [row] = await tx
        .insert(products)
        .values({
          shopId: shop.id,
          ...fields,
          categoryId: category ? (categoryIds.get(category) ?? null) : null,
          stock: fields.options.length > 0 ? null : fields.stock,
        })
        .returning({ id: products.id });
      if (!row) throw new Error('Failed to create product');
      if (fields.options.length > 0 && variants.length > 0) {
        await tx.insert(productVariants).values(
          variants.map((v, index) => ({
            productId: row.id,
            optionValues: v.values,
            price: v.price,
            vipPrice: v.vipPrice,
            stock: v.stock,
            isActive: v.isActive,
            sortOrder: index,
          })),
        );
      }
    }
    return shop;
  });
}
