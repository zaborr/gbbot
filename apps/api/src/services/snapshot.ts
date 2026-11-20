import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { EMPTY_VIP_CLUB, type GbSnapshot } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { categories, labs, productVariants, products, shops, testings } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { insertTesting } from './testing.js';
import { assertSlugFree, nextSortOrder, parseAddressKey, type ShopRow } from './shop.js';

/**
 * A GB's settings, catalog, labs and testings as set up, without orders,
 * customers or admins: what is copied when duplicating it, and what goes into
 * its JSON backup.
 */
export async function takeSnapshot(db: Database, shop: ShopRow): Promise<GbSnapshot> {
  const [categoryRows, productRows, labRows, testingRows] = await Promise.all([
    db
      .select()
      .from(categories)
      .where(eq(categories.shopId, shop.id))
      .orderBy(asc(categories.sortOrder), asc(categories.title)),
    db
      .select()
      .from(products)
      .where(and(eq(products.shopId, shop.id), eq(products.kind, 'sale')))
      .orderBy(asc(products.createdAt)),
    db.select().from(labs).where(eq(labs.shopId, shop.id)).orderBy(asc(labs.name)),
    db
      .select()
      .from(testings)
      .where(and(eq(testings.shopId, shop.id), ne(testings.status, 'cancelled')))
      .orderBy(desc(testings.createdAt)),
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
  const productSlug = new Map(productRows.map((p) => [p.id, p.slug]));
  const variantValues = new Map(variantRows.map((v) => [v.id, v.optionValues]));
  // The newest of each product or variant: only one can be running at a time.
  const tested = new Set<string>();
  const latest = testingRows.filter((t) => {
    const key = `${t.productId}:${t.variantId ?? ''}`;
    if (tested.has(key) || !productSlug.has(t.productId)) return false;
    tested.add(key);
    return t.variantId === null || variantValues.has(t.variantId);
  });

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
      checkoutFields: shop.checkoutFields,
      paymentSetup: shop.paymentSetup,
      addressPublicKey: shop.addressPublicKey,
      vipClub: shop.vipClub ?? EMPTY_VIP_CLUB,
      useGlobalVipClub: shop.useGlobalVipClub,
      allowGuests: shop.allowGuests,
      guestList: shop.guestList ?? EMPTY_VIP_CLUB,
      useGlobalGuests: shop.useGlobalGuests,
      showOrganizers: shop.showOrganizers,
      disclaimer: shop.disclaimerVersion > 0 ? shop.disclaimer : null,
      goalAmount: shop.goalAmount,
      goalShowAmount: shop.goalShowAmount,
      testingEnabled: shop.testingEnabled,
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
    labs: labRows.map((l) => ({ name: l.name, currency: l.currency, tests: l.tests, notes: l.notes })),
    testings: latest.reverse().map((t) => ({
      product: productSlug.get(t.productId)!,
      variant: t.variantId ? (variantValues.get(t.variantId) ?? null) : null,
      lab: t.lab,
      contribution: t.contribution,
      perUnit: t.perUnit,
      feeMode: t.feeMode,
      tiers: t.tiers,
      donationHours: t.donationHours,
      vialsPerUnit: t.vialsPerUnit,
      extraEnabled: t.extraEnabled,
      extraMin: t.extraMin,
      extraSignupHours: t.extraSignupHours,
      extraPayHours: t.extraPayHours,
      allowExternal: t.allowExternal,
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
        allowGuests: s.vipOnly && s.allowGuests,
        guestList: s.guestList,
        useGlobalGuests: s.useGlobalGuests,
        showOrganizers: s.showOrganizers,
        // A web administrator manages every GB already; it is not listed as its administrator.
        ownerIds: target.ownerId < 0 ? [] : [target.ownerId],
        paymentSetup: s.paymentSetup,
        currency: s.currency,
        orderFee: s.orderFee,
        orderFeeLabel: s.orderFeeLabel,
        vipNoFee: s.vipNoFee,
        vipNoShipping: s.vipNoShipping,
        autoCancelHours: s.autoCancelHours,
        shippingZones: s.shippingZones,
        checkoutFields: s.checkoutFields,
        addressPublicKey: key?.base64 ?? null,
        addressKeyFingerprint: key?.fingerprint ?? null,
        disclaimer: s.disclaimer,
        disclaimerVersion: s.disclaimer ? 1 : 0,
        goalAmount: s.goalAmount,
        goalShowAmount: s.goalShowAmount,
        testingEnabled: s.testingEnabled || snapshot.testings.length > 0,
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

    const made = new Map<string, { row: typeof products.$inferSelect; variants: Map<string, string> }>();
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
        .returning();
      if (!row) throw new Error('Failed to create product');
      const variantIds = new Map<string, string>();
      made.set(product.slug, { row, variants: variantIds });
      if (fields.options.length > 0 && variants.length > 0) {
        const rows = await tx.insert(productVariants).values(
          variants.map((v, index) => ({
            productId: row.id,
            optionValues: v.values,
            price: v.price,
            vipPrice: v.vipPrice,
            stock: v.stock,
            isActive: v.isActive,
            sortOrder: index,
          })),
        ).returning({ id: productVariants.id, optionValues: productVariants.optionValues });
        for (const v of rows) variantIds.set(v.optionValues.join('\u0000'), v.id);
      }
    }

    if (snapshot.labs.length > 0) {
      await tx.insert(labs).values(snapshot.labs.map((lab) => ({ shopId: shop.id, ...lab })));
    }

    // Testings come back open, with nobody in them: the GB is hidden until shown.
    const tested = new Set<string>();
    for (const { product: slug, variant, ...setup } of snapshot.testings) {
      const target = made.get(slug);
      const variantId = variant ? target?.variants.get(variant.join('\u0000')) : null;
      const what = variant ? `${slug} · ${variant.join(' / ')}` : slug;
      if (!target || variantId === undefined || (variant === null && target.row.options.length > 0)) {
        throw ApiError.badRequest('backup_testing', `The testing of "${what}" is not in the catalog of the backup`);
      }
      const key = `${slug}:${variantId ?? ''}`;
      if (tested.has(key)) {
        throw ApiError.badRequest('backup_testing', `"${what}" has two testings in the backup`);
      }
      tested.add(key);
      await insertTesting(
        tx,
        shop.id,
        target.row,
        variant ? { optionValues: variant } : undefined,
        { ...setup, productId: target.row.id, variantId: variantId ?? null },
        false,
      );
    }
    return shop;
  });
}
