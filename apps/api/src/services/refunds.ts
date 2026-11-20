import { and, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import type { PendingRefund, RefundReason } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { orders, testingEntries, testingExtraMembers, testings } from '../db/schema.js';
import { describeUser } from './team.js';

/**
 * What is owed back to customers in a GB, order by order, with why: a
 * cancelled order, a vial donated, money left over or given back from the
 * extra round, a cancelled testing, or an order made smaller. The organiser
 * sends it and marks it as sent (the usual refund of the order).
 */
export async function pendingRefunds(db: Database, shopId: string): Promise<PendingRefund[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.shopId, shopId),
        gt(orders.amountPaid, 0),
        or(eq(orders.status, 'cancelled'), sql`${orders.amountPaid} > ${orders.total}`),
      ),
    );
  if (rows.length === 0) return [];
  const ids = rows.map((o) => o.id);
  const entries = await db
    .select({ orderId: testingEntries.orderId, testing: testings })
    .from(testingEntries)
    .innerJoin(testings, eq(testingEntries.testingId, testings.id))
    .where(inArray(testingEntries.orderId, ids));
  const members = await db
    .select({ orderId: testingExtraMembers.orderId, state: testingExtraMembers.state, testing: testings })
    .from(testingExtraMembers)
    .innerJoin(testings, eq(testingExtraMembers.testingId, testings.id))
    .where(and(inArray(testingExtraMembers.orderId, ids), ne(testingExtraMembers.state, 'signed')));
  const result: PendingRefund[] = [];
  for (const order of rows) {
    const amount = order.amountPaid - (order.status === 'cancelled' ? 0 : order.total);
    if (amount <= 0) continue;
    const reasons = new Set<RefundReason>();
    if (order.status === 'cancelled') reasons.add('cancelled');
    for (const { testing } of entries.filter((e) => e.orderId === order.id)) {
      if (testing.status === 'cancelled') reasons.add('testingCancelled');
      const donor = testing.draw?.candidates.some(
        (c) => c.orderId === order.id && (testing.draw?.donors ?? []).includes(c.ref),
      );
      if (donor && testing.status === 'settled') reasons.add('vial');
    }
    for (const m of members.filter((x) => x.orderId === order.id)) {
      if (m.state === 'left') reasons.add('extraLeft');
      if (m.state === 'paid' && (m.testing.extra?.outcome?.refunded ?? 0) > 0) reasons.add('extraLeftover');
    }
    if (reasons.size === 0) reasons.add('changed');
    result.push({
      orderId: order.id,
      ref: order.id.slice(0, 8),
      customer: order.contactUsername
        ? `@${order.contactUsername.replace(/^@/, '')}`
        : order.userId !== null
          ? await describeUser(db, order.userId)
          : '—',
      amount,
      currency: order.currency,
      reasons: [...reasons],
      updatedAt: order.updatedAt.toISOString(),
    });
  }
  return result.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}
