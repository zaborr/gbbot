import { and, eq, lt, sql } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { images, products, shops } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

/** What the app sends: already made smaller on the phone. */
export const MAX_IMAGE_BYTES = 2_500_000;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const OWN = /\/api\/images\/([0-9a-f-]{36})$/i;

/** Where an image of ours is served from (absolute: it is stored as a link). */
export function imageUrl(env: Pick<Env, 'PUBLIC_URL' | 'RENDER_EXTERNAL_URL'>, origin: string, id: string): string {
  const base = (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? origin).replace(/\/+$/, '');
  return `${base}/api/images/${id}`;
}

/** The id of one of our images behind a link, if it is one. */
export function ownImageId(url: string | null | undefined): string | null {
  return url ? (OWN.exec(url)?.[1]?.toLowerCase() ?? null) : null;
}

export async function saveImage(
  db: Database,
  shopId: string,
  userId: number,
  mime: string,
  data: Buffer,
): Promise<string> {
  if (!TYPES.includes(mime)) throw ApiError.badRequest('bad_image', 'Send a JPEG, PNG or WebP image');
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    throw ApiError.badRequest('image_too_big', 'The image is too big');
  }
  const [row] = await db
    .insert(images)
    .values({ shopId, mime, data, size: data.length, uploadedBy: userId })
    .returning({ id: images.id });
  if (!row) throw new Error('Failed to save the image');
  return row.id;
}

export async function getImage(db: Database, id: string): Promise<Response> {
  const [row] = await db.select().from(images).where(eq(images.id, id));
  if (!row) throw ApiError.notFound('Image not found');
  return new Response(new Uint8Array(row.data), {
    headers: {
      'Content-Type': row.mime,
      // Never changes: a new image is a new id.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Whether a link is still used by a GB or a product (a copy of a GB shares them). */
async function inUse(db: Database, url: string): Promise<boolean> {
  const id = ownImageId(url);
  if (!id) return true;
  const pattern = `%/api/images/${id}`;
  const [shop] = await db.select({ id: shops.id }).from(shops).where(sql`${shops.imageUrl} ilike ${pattern}`).limit(1);
  if (shop) return true;
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(sql`${products.imageUrl} ilike ${pattern}`)
    .limit(1);
  return Boolean(product);
}

/** An image of ours replaced or removed: it goes once nothing uses it. */
export async function dropImageIfUnused(db: Database, url: string | null | undefined): Promise<void> {
  const id = ownImageId(url);
  if (!id || (await inUse(db, url!))) return;
  await db.delete(images).where(eq(images.id, id));
}

/** Uploaded but never saved (the form was left): gone after a day. */
export async function deleteUnusedImages(db: Database, now = new Date()): Promise<number> {
  const old = await db
    .select({ id: images.id })
    .from(images)
    .where(lt(images.createdAt, new Date(now.getTime() - 24 * 3600_000)));
  let dropped = 0;
  for (const { id } of old) {
    const pattern = `%/api/images/${id}`;
    const [shop] = await db.select({ id: shops.id }).from(shops).where(sql`${shops.imageUrl} ilike ${pattern}`).limit(1);
    const [product] = shop
      ? [undefined]
      : await db.select({ id: products.id }).from(products).where(sql`${products.imageUrl} ilike ${pattern}`).limit(1);
    if (shop || product) continue;
    await db.delete(images).where(and(eq(images.id, id)));
    dropped++;
  }
  return dropped;
}
