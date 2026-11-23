import { describe, expect, it } from 'vitest';
import { goodsStatus } from './order.js';

const order = (patch: Partial<Parameters<typeof goodsStatus>[0]>) => ({
  status: 'pending' as const,
  resumeStatus: null,
  donationDue: 0,
  amountPaid: 0,
  total: 5000,
  ...patch,
});

describe('where an order\'s products are', () => {
  it('follows the status when nothing else is owed', () => {
    expect(goodsStatus(order({}))).toBe('pending');
    expect(goodsStatus(order({ status: 'paid', amountPaid: 5000 }))).toBe('paid');
    expect(goodsStatus(order({ status: 'shipped', amountPaid: 5000 }))).toBe('shipped');
  });

  it('keeps paid or sent products there while only a donation is owed', () => {
    // Paid, then a donation of 10 added: pending again, products still paid.
    expect(goodsStatus(order({ total: 6000, amountPaid: 5000, donationDue: 1000 }))).toBe('paid');
    // Sent already: it goes back to sent.
    expect(goodsStatus(order({ total: 6000, amountPaid: 5000, donationDue: 1000, resumeStatus: 'shipped' }))).toBe('shipped');
    expect(goodsStatus(order({ status: 'awaiting_payment', total: 6000, amountPaid: 5000, donationDue: 1000 }))).toBe('paid');
  });

  it('is unpaid when part of the products is still owed', () => {
    // A change after paying left a difference beyond the donation.
    expect(goodsStatus(order({ total: 8000, amountPaid: 5000, donationDue: 1000 }))).toBe('pending');
    expect(goodsStatus(order({ total: 6000, amountPaid: 0, donationDue: 1000 }))).toBe('pending');
  });
});
