import { and, inArray, ne, sql } from 'drizzle-orm';
import type { Testing, TestingNext } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { orders, testingEntries, testings } from '../db/schema.js';
import type { ShopRow } from './shop.js';
import { donationsOpen } from './testing.js';
import { drawBlocker } from './testingDraw.js';
import { extraCanOpen, extraGoing } from './testingExtra.js';

type TestingRow = typeof testings.$inferSelect;

/** People in each testing whose order is not paid in full yet (nor cancelled). */
async function unpaidByTesting(db: Database, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: testingEntries.testingId, n: sql<number>`count(*)::int` })
    .from(testingEntries)
    .innerJoin(orders, sql`${testingEntries.orderId} = ${orders.id}`)
    .where(
      and(
        inArray(testingEntries.testingId, [...ids]),
        ne(orders.status, 'cancelled'),
        sql`${testingEntries.amount} > 0`,
        sql`${orders.amountPaid} < ${orders.total}`,
      ),
    )
    .groupBy(testingEntries.testingId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/**
 * Where a testing is and what comes next. `blocker` is why the draw cannot be
 * launched yet (drawBlocker), only asked for a closed one.
 */
export function nextOf(
  row: TestingRow,
  view: Pick<Testing, 'tiers'>,
  shop: Pick<ShopRow, 'closedAt' | 'closesAt'>,
  unpaid: number,
  blocker: string | null,
  now = new Date(),
): TestingNext {
  const base = { action: false, until: null, unpaid };
  switch (row.status) {
    case 'cancelled':
      return { ...base, phase: 'cancelled', step: null };
    case 'settled':
      return { ...base, phase: 'done', step: null };
    case 'open':
      return { ...base, phase: 'open', step: 'wait_gb', until: shop.closesAt?.toISOString() ?? null };
    case 'drawing':
      return { ...base, phase: 'drawing', step: 'wait_block' };
    case 'closed': {
      if (!shop.closedAt) return { ...base, phase: 'open', step: 'wait_gb', until: shop.closesAt?.toISOString() ?? null };
      if (extraGoing(row)) return { ...base, phase: 'extra', step: 'wait_extra', until: row.extra?.until ?? null };
      if (donationsOpen(row, now)) {
        return { ...base, phase: 'window', step: 'wait_window', until: row.donationsUntil?.toISOString() ?? null };
      }
      if (blocker === 'unpaid') return { ...base, phase: 'draw', step: 'unpaid', action: true };
      if (!view.tiers.some((tier) => tier.reached)) {
        // Nothing reached: the extra round can still be opened (again, if it got nothing).
        if (extraCanOpen(row)) return { ...base, phase: 'extra', step: 'extra', action: true };
        // Else there is nothing to draw, only to close it.
        return { ...base, phase: 'draw', step: 'settle', action: true };
      }
      return { ...base, phase: 'draw', step: 'draw', action: true };
    }
    case 'drawn': {
      const lab = row.labProgress ?? {};
      if (!lab.sentAt) return { ...base, phase: 'lab', step: 'vials', action: true };
      if (!lab.receivedAt) return { ...base, phase: 'lab', step: 'wait_lab' };
      const extraTiers = row.extra?.outcome?.tiers.length ?? 0;
      if (!row.report || (extraTiers > 0 && !row.extraReport)) {
        // Results expected by a day: from then on, it is the organisers' turn to send them.
        const due = lab.expected ? new Date(`${lab.expected}T23:59:59Z`) : null;
        return due && due < now
          ? { ...base, phase: 'lab', step: 'report', action: true, until: lab.expected ?? null }
          : { ...base, phase: 'lab', step: 'wait_report', until: lab.expected ?? null };
      }
      return { ...base, phase: 'lab', step: 'settle', action: true };
    }
    default:
      return { ...base, phase: 'done', step: null };
  }
}

/** The organisers' list, each testing with where it is and what comes next. */
export async function withNext(db: Database, shop: ShopRow, list: Testing[]): Promise<Testing[]> {
  const ids = list.map((x) => x.id);
  if (ids.length === 0) return list;
  const rows = await db.select().from(testings).where(inArray(testings.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const unpaid = await unpaidByTesting(db, ids);
  const now = new Date();
  return Promise.all(
    list.map(async (view) => {
      const row = byId.get(view.id);
      if (!row) return view;
      const waiting = row.status === 'closed' && !extraGoing(row) && !donationsOpen(row, now);
      const blocker = waiting ? await drawBlocker(db, shop, row) : null;
      return { ...view, next: nextOf(row, view, shop, unpaid.get(row.id) ?? 0, blocker, now) };
    }),
  );
}
