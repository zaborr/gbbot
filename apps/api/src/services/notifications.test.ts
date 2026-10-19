import { describe, expect, it } from 'vitest';
import { ADMIN_STATUS_CHANGES, type Order } from '@tma-shop/shared';
import { buildStatusMessage } from './notifications.js';

const base: Order = {
  id: 'abcd1234-0000-4000-8000-000000000000',
  shopId: 's',
  userId: 1,
  status: 'paid',
  items: [],
  total: 5490,
  fee: 0,
  shipping: 590,
  shippingZoneName: 'Spain',
  encryptedAddress: null,
  addressKeyFingerprint: null,
  currency: 'USDC',
  paymentNetwork: 'USDC · Base',
  paymentTxHash: '0xabc',
  paymentTxUrl: null,
  contactUsername: 'ana',
  trackingNumber: null,
  statusNote: null,
  amountPaid: 5490,
  amountDue: 0,
  amountSubmitted: 0,
  changeRequest: null,
  paymentLog: [],
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
};

describe('buildStatusMessage', () => {
  it('confirms a payment', () => {
    const text = buildStatusMessage('en', 'Demo', base, 'awaiting_payment');
    expect(text).toContain('Payment confirmed for Demo · order #abcd1234');
  });

  it('tells the customer a rejected payment must be sent again', () => {
    const order: Order = { ...base, status: 'pending', paymentTxHash: null, amountPaid: 0, amountDue: 5490 };
    const text = buildStatusMessage('en', 'Demo', order, 'awaiting_payment');
    expect(text).toContain('could not verify your payment');
  });

  it('includes tracking and the shop note when shipped', () => {
    const order: Order = {
      ...base,
      status: 'shipped',
      trackingNumber: 'RR123456789ES',
      statusNote: 'Arrives on Friday',
    };
    const text = buildStatusMessage('en', 'Demo', order, 'paid');
    expect(text).toContain('has been shipped');
    expect(text).toContain('Tracking: RR123456789ES');
    expect(text).toContain('Message from the organiser: Arrives on Friday');
  });

  it('mentions the refund when a paid order is cancelled', () => {
    const order: Order = { ...base, status: 'cancelled', amountDue: -5490 };
    expect(buildStatusMessage('en', 'Demo', order, 'paid')).toContain('will refund you 54.90 USDC');
  });
});

describe('buildStatusMessage in Spanish', () => {
  it('speaks the customer\'s language', () => {
    const order: Order = { ...base, status: 'shipped', trackingNumber: 'RR1' };
    const text = buildStatusMessage('es', 'Demo', order, 'paid');
    expect(text).toContain('Tu pedido Demo · pedido #abcd1234 ya está enviado.');
    expect(text).toContain('Seguimiento: RR1');
  });
});

describe('ADMIN_STATUS_CHANGES', () => {
  it('only lets delivered and cancelled orders stay final', () => {
    expect(ADMIN_STATUS_CHANGES.fulfilled).toEqual([]);
    expect(ADMIN_STATUS_CHANGES.cancelled).toEqual([]);
    expect(ADMIN_STATUS_CHANGES.paid).toContain('shipped');
    expect(ADMIN_STATUS_CHANGES.awaiting_payment).toContain('pending');
  });
});
