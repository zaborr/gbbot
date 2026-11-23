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

/**
 * Where the order's products are. An order already paid (or sent) that then
 * gets a donation or a share of a testing's extra round to pay goes back to
 * pending until that is paid; its products stay where they were: paid, or
 * sent (the status it goes back to).
 */
export function goodsStatus(
  order: Pick<Order, 'status' | 'resumeStatus' | 'productsPaid' | 'amountPaid' | 'amountDue'>,
): OrderStatus {
  const waiting = order.status === 'pending' || order.status === 'awaiting_payment';
  // Paid in full but left pending (a testing part taken off later), or only a testing's part owed.
  if (waiting && order.amountPaid > 0 && (order.amountDue <= 0 || order.productsPaid)) {
    return order.resumeStatus ?? 'paid';
  }
  return order.status;
}

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
  /** A testing's line (what was given, a share of its extra round): not changed with the products. */
  testing: z.boolean().optional(),
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
  /** Team views: the customer is blacklisted (the GB does not exist for them). */
  customerBlocked: z.boolean().optional(),
  /** For the organisers' list: the testings it takes part in (what each tests). */
  testings: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  /** Team views: what was tested in extra rounds whose share this customer did not pay. */
  extraUnpaid: z.array(z.string()).optional(),
  /** Customer; null once the order is anonymized (data retention). */
  userId: telegramUserId.nullable(),
  status: orderStatus,
  /** Empty for an order only to take part in a testing from outside. */
  items: z.array(orderItem),
  /** Only to take part in a testing from outside: nothing to send. */
  external: z.boolean(),
  /** The testing an order from outside is for. */
  externalTestingId: z.string().nullable(),
  /** Placed by a VIP: VIP prices apply to it, also when it is changed later. */
  isVip: z.boolean(),
  /** Total including `fee`. */
  total: moneyAmount,
  /** Per-order fee charged once, frozen when the order was created. */
  fee: moneyAmount,
  /** Shipping cost charged once (0 when free or not shipped). */
  shipping: moneyAmount,
  /** Contributions to product testings on this order (part of `total`). */
  testing: moneyAmount,
  /** Drawn to donate one vial of each of these (product · variant) to a testing. */
  donatedVials: z.array(z.string()),
  /** Given to testings and not paid yet (the only thing the order owes, when it was paid or sent). */
  donationDue: z.number().int(),
  /**
   * The products (and shipping and fee) are paid: what is missing, if anything,
   * is only for testings (a fee added later, something given, an extra share).
   */
  productsPaid: z.boolean(),
  /** Sent (or delivered) and waiting only for that: where it goes back once paid. */
  resumeStatus: orderStatus.nullable(),
  /** Name of the shipping zone chosen at checkout. */
  shippingZoneName: z.string().nullable(),
  /**
   * Delivery address encrypted on the customer's device with the shop's public
   * key (JSON envelope). Only the shop admin's private key opens it.
   */
  encryptedAddress: z.string().nullable(),
  /** Fingerprint of the key the address was encrypted with. */
  addressKeyFingerprint: z.string().nullable(),
  /**
   * Details the customer added later (email, phone, notes), each encrypted the
   * same way. They never replace what the order had: they only fill gaps.
   */
  addressExtras: z.array(z.object({ encrypted: z.string(), at: isoDateTime })),
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
  carrier: z.string().nullable(),
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

/** Why money is owed back. */
export type RefundReason =
  | 'cancelled'
  | 'vial'
  | 'extraLeft'
  | 'extraLeftover'
  | 'testingCancelled'
  | 'changed';

/** One order with money owed back to its customer (the organiser's list). */
export interface PendingRefund {
  orderId: string;
  ref: string;
  customer: string;
  amount: number;
  currency: string;
  reasons: RefundReason[];
  updatedAt: string;
}
