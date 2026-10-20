import { z } from 'zod';
import { currencyCode, id, isoDateTime, moneyAmount } from './common.js';
import { telegramUserId } from './user.js';

export const orderStatus = z.enum([
  'pending', // created, not yet paid
  'awaiting_payment', // a transaction was sent and is being checked
  'paid', // payment confirmed, being prepared
  'cancelled',
  'shipped', // sent to the customer
  'fulfilled', // delivered / completed
]);
export type OrderStatus = z.infer<typeof orderStatus>;

/**
 * Status changes an admin can make. `awaiting_payment → pending` rejects the
 * submitted payment; cancelling a paid order returns its stock and leaves the
 * money paid as a refund owed.
 */
export const ADMIN_STATUS_CHANGES: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  awaiting_payment: ['paid', 'pending', 'cancelled'],
  paid: ['shipped', 'fulfilled', 'cancelled'],
  shipped: ['fulfilled'],
  fulfilled: [],
  cancelled: [],
};

/** Orders counted as sales: payment confirmed, whether shipped or delivered. */
export function isSaleStatus(status: OrderStatus): boolean {
  return status === 'paid' || status === 'shipped' || status === 'fulfilled';
}

/** Line item snapshot — title and price are frozen at order time. */
export const orderItem = z.object({
  productId: id,
  /** Chosen variant, if the product has variants. */
  variantId: id.nullable(),
  /** Snapshot of the variant label, e.g. "Red / M". */
  variantLabel: z.string().nullable(),
  /** Product title when ordered (Spanish) and its English version, if any. */
  title: z.string().min(1).max(256),
  titleEn: z.string().max(256).nullable().optional(),
  unitPrice: moneyAmount,
  quantity: z.number().int().positive(),
  subtotal: moneyAmount,
});
export type OrderItem = z.infer<typeof orderItem>;

/** A customer's requested modification, waiting for admin approval. */
export const orderChangeRequest = z.object({
  /** The full new item list (replaces the current items once approved). */
  items: z.array(orderItem).min(1),
  total: moneyAmount,
  requestedAt: z.string(),
});
export type OrderChangeRequest = z.infer<typeof orderChangeRequest>;

/** A confirmed payment received, or a refund sent back to the customer. */
export const paymentLogEntry = z.object({
  type: z.enum(['payment', 'refund']),
  /** In the order's currency. */
  amount: moneyAmount,
  /** Paid in the other token: what arrived, in which token and at what rate (×10 000). */
  paid: z.object({ amount: moneyAmount, token: z.string(), rate: z.number().int() }).optional(),
  network: z.string().nullable(),
  txHash: z.string().nullable(),
  at: z.string(),
});
export type PaymentLogEntry = z.infer<typeof paymentLogEntry>;

/**
 * Automatic check of a crypto payment on the blockchain: running, passed (the
 * order was confirmed) or failed with a reason (an admin decides).
 */
export const paymentCheck = z.object({
  status: z.enum(['checking', 'verified', 'failed']),
  /** Why it failed, e.g. `short`, `ambiguous`, `not_found`. */
  reason: z.string().nullable(),
  /** Values for the reason text (amounts, counts…). */
  vars: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
  at: z.string(),
});
export type PaymentCheck = z.infer<typeof paymentCheck>;

export const order = z.object({
  id,
  shopId: id,
  /** Customer; null once the order is anonymized (data retention). */
  userId: telegramUserId.nullable(),
  status: orderStatus,
  items: z.array(orderItem).min(1),
  /** Placed by a VIP: VIP prices apply to it, also when it is changed later. */
  isVip: z.boolean(),
  /** Total including `fee`. */
  total: moneyAmount,
  /** Per-order fee charged once, frozen when the order was created. */
  fee: moneyAmount,
  /** Shipping cost charged once (0 when free or not shipped). */
  shipping: moneyAmount,
  /** Name of the shipping zone chosen at checkout. */
  shippingZoneName: z.string().nullable(),
  /**
   * Delivery address encrypted on the customer's device with the shop's public
   * key (JSON envelope). Only the shop admin's private key opens it.
   */
  encryptedAddress: z.string().nullable(),
  /** Fingerprint of the key the address was encrypted with. */
  addressKeyFingerprint: z.string().nullable(),
  currency: currencyCode,
  /** Crypto payment method chosen by the customer, e.g. "USDC · Base". */
  paymentNetwork: z.string().nullable(),
  /** Transaction hash (or, for manual methods, the customer's reference). */
  paymentTxHash: z.string().nullable(),
  /** Block-explorer link for `paymentTxHash`, when the network is known. */
  paymentTxUrl: z.string().nullable(),
  /** Automatic on-chain check of the last transaction, if any. */
  paymentCheck: paymentCheck.nullable(),
  /**
   * The transaction under review pays in the other token: its token and the
   * rate (×10 000) it is checked at. Null when paid in the order's currency.
   */
  paymentExchange: z.object({ token: z.string(), rate: z.number().int() }).nullable(),
  /**
   * Paid with a manual method (Wise, Bizum…): `paymentNetwork` is its name,
   * `paymentTxHash` the customer's reference, and an admin checks it by hand.
   */
  paymentManual: z.boolean(),
  /** Customer's Telegram username (without @), given at checkout for contact. */
  contactUsername: z.string().nullable(),
  /** Shipment tracking number or link, set when the order is shipped. */
  trackingNumber: z.string().nullable(),
  /** Last message from the shop to the customer about this order. */
  statusNote: z.string().nullable(),
  /** Confirmed money received, net of refunds. */
  amountPaid: moneyAmount,
  /**
   * `total - amountPaid` (for a cancelled order, `-amountPaid`): >0 still to
   * pay, <0 to refund to the customer.
   */
  amountDue: z.number().int(),
  /** Amount covered by the transaction currently awaiting verification. */
  amountSubmitted: moneyAmount,
  /** Pending modification requested by the customer, if any. */
  changeRequest: orderChangeRequest.nullable(),
  /** Confirmed payments and refunds, oldest first. */
  paymentLog: z.array(paymentLogEntry),
  /** When it was delivered or cancelled. */
  closedAt: isoDateTime.nullable(),
  /** When the address and the link to the customer were removed. */
  anonymizedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Order = z.infer<typeof order>;

/**
 * Whether the customer still has to pay this order: unpaid, or with a
 * difference left after an approved change. Not when a payment is already
 * being verified.
 */
export function awaitsPayment(order: Pick<Order, 'status' | 'amountDue'>): boolean {
  return order.status === 'pending' && order.amountDue > 0;
}

/**
 * Whether the customer can edit the order directly, without the organiser's
 * approval: nothing paid and no payment sent for review yet.
 */
export function editableDirectly(
  order: Pick<Order, 'status' | 'amountPaid' | 'amountSubmitted'>,
): boolean {
  return order.status === 'pending' && order.amountPaid === 0 && order.amountSubmitted === 0;
}
