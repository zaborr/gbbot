import { describe, expect, it } from 'vitest';
import { goodsStatus } from './order.js';

const order = (patch: Partial<Parameters<typeof goodsStatus>[0]>) => ({
  status: 'pending' as const,
  resumeStatus: null,
  productsPaid: false,
  amountPaid: 0,
  amountDue: 5000,
  ...patch,
});

describe('where an order\'s products are', () => {
  it('follows the status when nothing else is owed', () => {
    expect(goodsStatus(order({}))).toBe('pending');
    expect(goodsStatus(order({ status: 'paid', amountPaid: 5000, amountDue: 0, productsPaid: true }))).toBe('paid');
    expect(goodsStatus(order({ status: 'shipped', amountPaid: 5000, amountDue: 0, productsPaid: true }))).toBe('shipped');
  });

  it('keeps paid or sent products there while only a testing\'s part is owed', () => {
    expect(goodsStatus(order({ amountPaid: 5000, amountDue: 1000, productsPaid: true }))).toBe('paid');
    expect(goodsStatus(order({ amountPaid: 5000, amountDue: 1000, productsPaid: true, resumeStatus: 'shipped' }))).toBe('shipped');
    expect(goodsStatus(order({ status: 'awaiting_payment', amountPaid: 5000, amountDue: 1000, productsPaid: true }))).toBe('paid');
  });

  it('is paid when paid in full but left pending', () => {
    expect(goodsStatus(order({ amountPaid: 5000, amountDue: 0 }))).toBe('paid');
    expect(goodsStatus(order({ amountPaid: 6000, amountDue: -1000, resumeStatus: 'fulfilled' }))).toBe('fulfilled');
  });

  it('is unpaid when part of the products is still owed', () => {
    expect(goodsStatus(order({ amountPaid: 5000, amountDue: 3000 }))).toBe('pending');
    expect(goodsStatus(order({ amountPaid: 0, amountDue: 6000 }))).toBe('pending');
  });
});
