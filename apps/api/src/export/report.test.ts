import { describe, expect, it } from 'vitest';
import type { Order } from '@tma-shop/shared';
import { buildReport, selectOrders } from './report.js';

function order(partial: Partial<Order> & Pick<Order, 'id' | 'status' | 'createdAt'>): Order {
  return {
    shopId: 's',
    userId: 101,
    items: [
      {
        productId: 'p1',
        variantId: 'v1',
        variantLabel: 'Red / M',
        title: 'T-shirt',
        unitPrice: 900,
        quantity: 2,
        subtotal: 1800,
      },
    ],
    total: 1800,
    fee: 0,
    shipping: 0,
    shippingZoneName: null,
    encryptedAddress: null,
    addressKeyFingerprint: null,
    currency: 'USDC',
    paymentNetwork: null,
    paymentTxHash: null,
    paymentTxUrl: null,
    contactUsername: 'ana_test',
    trackingNumber: null,
    statusNote: null,
    amountPaid: 0,
    amountDue: 1800,
    amountSubmitted: 0,
    changeRequest: null,
    paymentLog: [],
    updatedAt: partial.createdAt,
    ...partial,
  };
}

const orders = [
  order({ id: 'aaaa1111-x', status: 'paid', createdAt: '2026-10-05T09:30:00.000Z' }),
  order({ id: 'bbbb2222-x', status: 'fulfilled', createdAt: '2026-09-20T09:30:00.000Z' }),
  order({ id: 'cccc3333-x', status: 'pending', createdAt: '2026-10-06T09:30:00.000Z' }),
];

describe('export report', () => {
  it('filters by scope and date range', () => {
    const paid = selectOrders(orders, { format: 'xlsx', scope: 'paid' });
    expect(paid.map((o) => o.id)).toEqual(['bbbb2222-x', 'aaaa1111-x']);
    const october = selectOrders(orders, {
      format: 'xlsx',
      scope: 'all',
      from: '2026-10-01T00:00:00.000Z',
    });
    expect(october.map((o) => o.id)).toEqual(['aaaa1111-x', 'cccc3333-x']);
    expect(selectOrders(orders, { format: 'xlsx', scope: 'toFulfil' })).toHaveLength(1);
  });

  it('writes one CSV row per order line with numeric amounts', () => {
    const file = buildReport({
      shopName: 'Demo',
      shopSlug: 'demo',
      feeLabel: 'Fee',
      orders,
      customers: new Map(),
      request: { format: 'csv-lines', scope: 'toFulfil', timeZone: 'UTC' },
      now: new Date('2026-10-13T00:00:00.000Z'),
    });
    expect(file.fileName).toBe('demo-orders-toFulfil-2026-10-13-lines.csv');
    expect(file.orderCount).toBe(1);
    expect(file.data.toString('utf8')).toContain(
      '#aaaa1111,2026-10-05 09:30,Paid,@ana_test,T-shirt,Red / M,2,9.00,18.00,USDC',
    );
  });
});
