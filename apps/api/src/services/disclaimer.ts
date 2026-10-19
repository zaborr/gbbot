import { and, eq, gte, sql } from 'drizzle-orm';
import type { DisclaimerAdminView } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { disclaimerAcceptances, shops } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import type { ShopRow } from './shop.js';

/**
 * A GB's disclaimer: a text customers accept once before entering. Admins can
 * fix it quietly (a minor correction) or ask everyone to accept it again.
 */

function hasDisclaimer(shop: ShopRow): boolean {
  return Boolean(shop.disclaimer) && shop.disclaimerVersion > 0;
}

/** Whether `userId` still has to accept the GB's current disclaimer. */
export async function disclaimerPending(
  db: Database,
  shop: ShopRow,
  userId: number | undefined,
): Promise<boolean> {
  if (!hasDisclaimer(shop)) return false;
  if (userId === undefined) return true;
  const row = await db.query.disclaimerAcceptances.findFirst({
    where: and(
      eq(disclaimerAcceptances.shopId, shop.id),
      eq(disclaimerAcceptances.userId, userId),
      gte(disclaimerAcceptances.version, shop.disclaimerVersion),
    ),
    columns: { version: true },
  });
  return row === undefined;
}

/** Records that the user accepted `version` (it must be the current one). */
export async function acceptDisclaimer(
  db: Database,
  shop: ShopRow,
  userId: number,
  version: number,
): Promise<void> {
  if (!hasDisclaimer(shop) || version !== shop.disclaimerVersion) {
    throw ApiError.conflict('disclaimer_changed', 'The conditions changed. Read them again.');
  }
  await db
    .insert(disclaimerAcceptances)
    .values({ shopId: shop.id, userId, version })
    .onConflictDoUpdate({
      target: [disclaimerAcceptances.shopId, disclaimerAcceptances.userId],
      set: { version, acceptedAt: new Date() },
    });
}

export async function getDisclaimerAdmin(db: Database, shop: ShopRow): Promise<DisclaimerAdminView> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(disclaimerAcceptances)
    .where(
      and(
        eq(disclaimerAcceptances.shopId, shop.id),
        gte(disclaimerAcceptances.version, Math.max(shop.disclaimerVersion, 1)),
      ),
    );
  return {
    text: shop.disclaimer ?? '',
    version: hasDisclaimer(shop) ? shop.disclaimerVersion : 0,
    accepted: hasDisclaimer(shop) ? Number(row?.n ?? 0) : 0,
  };
}

/**
 * Sets the text (empty removes it). A new text, or `askAgain`, makes
 * everyone accept it again; otherwise it is a minor correction.
 */
export async function updateDisclaimer(
  db: Database,
  shop: ShopRow,
  input: { text: string; askAgain: boolean },
): Promise<DisclaimerAdminView> {
  const text = input.text.trim();
  const values =
    text === ''
      ? { disclaimer: null }
      : {
          disclaimer: text,
          disclaimerVersion:
            !hasDisclaimer(shop) || input.askAgain ? shop.disclaimerVersion + 1 : shop.disclaimerVersion,
        };
  const [row] = await db.update(shops).set(values).where(eq(shops.id, shop.id)).returning();
  if (!row) throw ApiError.notFound('Shop not found');
  return getDisclaimerAdmin(db, row);
}
