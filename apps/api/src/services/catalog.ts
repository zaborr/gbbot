import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { CatalogQuery, Category, Product } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { categories, products } from '../db/schema.js';
import { toCategoryDTO, toProductDTO } from '../db/mappers.js';
import { loadVariants } from './variants.js';

export async function listCategories(db: Database, shopId: string): Promise<Category[]> {
  const rows = await db
    .select()
    .from(categories)
    .where(eq(categories.shopId, shopId))
    .orderBy(asc(categories.sortOrder), asc(categories.title));
  return rows.map(toCategoryDTO);
}

export interface ProductPage {
  items: Product[];
  page: number;
  limit: number;
  total: number;
}

/** Lists active products with optional category filter, text search and paging. */
export async function listProducts(
  db: Database,
  shopId: string,
  query: CatalogQuery,
  /** The viewer is a VIP or an admin: VIP prices and VIP-only products. */
  showVip = false,
): Promise<ProductPage> {
  const filters = [eq(products.shopId, shopId), eq(products.isActive, true)];
  if (!showVip) filters.push(eq(products.vipOnly, false));
  if (query.categoryId) filters.push(eq(products.categoryId, query.categoryId));
  // Search in both languages.
  if (query.search) {
    const pattern = `%${query.search}%`;
    const match = or(ilike(products.title, pattern), ilike(products.titleEn, pattern));
    if (match) filters.push(match);
  }
  const where = and(...filters);

  const offset = (query.page - 1) * query.limit;
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(products)
      .where(where)
      .orderBy(desc(products.createdAt))
      .limit(query.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(where),
  ]);

  const variants = await loadVariants(
    db,
    rows.map((row) => row.id),
    { activeOnly: true },
  );
  return {
    items: rows.map((row) => toProductDTO(row, variants.get(row.id), showVip)),
    page: query.page,
    limit: query.limit,
    total: counted?.count ?? 0,
  };
}

export async function getProductById(
  db: Database,
  shopId: string,
  productId: string,
  includeHidden = false,
  showVip = false,
): Promise<Product | undefined> {
  const row = await db.query.products.findFirst({
    where: and(eq(products.shopId, shopId), eq(products.id, productId)),
  });
  // Hidden and VIP-only products stay hidden from customers, even with a direct link.
  if (!row || (!row.isActive && !includeHidden) || (row.vipOnly && !showVip)) return undefined;
  const variants = await loadVariants(db, [row.id], { activeOnly: true });
  return toProductDTO(row, variants.get(row.id), showVip);
}
