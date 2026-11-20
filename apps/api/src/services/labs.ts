import { and, asc, eq } from 'drizzle-orm';
import type { Lab, LabRequest } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { labs } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

type LabRow = typeof labs.$inferSelect;

const toLab = (row: LabRow): Lab => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  tests: row.tests,
  notes: row.notes,
  updatedAt: row.updatedAt.toISOString(),
});

/** The GB's labs, by name. */
export async function listLabs(db: Database, shopId: string): Promise<Lab[]> {
  const rows = await db.select().from(labs).where(eq(labs.shopId, shopId)).orderBy(asc(labs.name));
  return rows.map(toLab);
}

export async function createLab(db: Database, shopId: string, input: LabRequest): Promise<Lab> {
  const [row] = await db.insert(labs).values({ shopId, ...input }).returning();
  if (!row) throw new Error('Failed to save the lab');
  return toLab(row);
}

export async function updateLab(db: Database, shopId: string, id: string, input: LabRequest): Promise<Lab> {
  const [row] = await db
    .update(labs)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(labs.shopId, shopId), eq(labs.id, id)))
    .returning();
  if (!row) throw ApiError.notFound('Lab not found');
  return toLab(row);
}

/** Testings keep their own tiers: removing a lab changes none of them. */
export async function deleteLab(db: Database, shopId: string, id: string): Promise<void> {
  const [row] = await db
    .delete(labs)
    .where(and(eq(labs.shopId, shopId), eq(labs.id, id)))
    .returning({ id: labs.id });
  if (!row) throw ApiError.notFound('Lab not found');
}
