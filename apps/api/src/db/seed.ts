import { createDb, createPool } from './client.js';
import { eq } from 'drizzle-orm';
import { categories, products, shops } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tma:tma@localhost:5432/tma_shop';

/**
 * Adds a demo GB for local development. Only that demo GB is replaced when the
 * seed runs again; other GBs are never touched.
 */
async function main(): Promise<void> {
  const pool = createPool(DATABASE_URL);
  const db = createDb(pool);

  console.log('Replacing the demo GB…');
  await db.delete(shops).where(eq(shops.slug, 'demo-tea-shop'));

  const [shop] = await db
    .insert(shops)
    .values({
      name: 'Demo Tea GB',
      slug: 'demo-tea-shop',
      description: 'Demo group buy. Prices in USDC.',
      // Default currency for new products. Prices are in cents of the token
      // (1290 = 12.90 USDC); each product can be USDC or EURC.
      currency: 'USDC',
    })
    .returning();
  if (!shop) throw new Error('Failed to create demo shop');

  const [tea, accessories] = await db
    .insert(categories)
    .values([
      { shopId: shop.id, slug: 'tea', title: 'Tea', sortOrder: 1 },
      { shopId: shop.id, slug: 'accessories', title: 'Accessories', sortOrder: 2 },
    ])
    .returning();
  if (!tea || !accessories) throw new Error('Failed to create categories');

  await db.insert(products).values([
    {
      shopId: shop.id,
      categoryId: tea.id,
      slug: 'sencha-green',
      title: 'Sencha Green Tea',
      description: 'Bright, grassy Japanese green tea. 100g.',
      price: 1290,
      currency: 'USDC',
      imageUrl: null,
      stock: 25,
      isActive: true,
    },
    {
      shopId: shop.id,
      categoryId: tea.id,
      slug: 'earl-grey',
      title: 'Earl Grey',
      description: 'Classic black tea with bergamot. 100g.',
      price: 990,
      currency: 'USDC',
      imageUrl: null,
      stock: 40,
      isActive: true,
    },
    {
      shopId: shop.id,
      categoryId: tea.id,
      slug: 'pu-erh-aged',
      title: 'Aged Pu-erh',
      description: 'Deep, earthy fermented tea, 5 years aged. 50g.',
      price: 2490,
      currency: 'USDC',
      imageUrl: null,
      stock: null, // not stock-tracked
      isActive: true,
    },
    {
      shopId: shop.id,
      categoryId: accessories.id,
      slug: 'cast-iron-teapot',
      title: 'Cast Iron Teapot',
      description: 'Traditional tetsubin, 600ml.',
      price: 5900,
      currency: 'USDC',
      imageUrl: null,
      stock: 8,
      isActive: true,
    },
    {
      shopId: shop.id,
      categoryId: accessories.id,
      slug: 'gaiwan',
      title: 'Porcelain Gaiwan',
      description: 'White porcelain gaiwan for gongfu brewing, 120ml.',
      price: 1890,
      currency: 'USDC',
      imageUrl: null,
      stock: 15,
      isActive: true,
    },
  ]);

  console.log(`Seed complete: demo GB "${shop.slug}".`);

  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
