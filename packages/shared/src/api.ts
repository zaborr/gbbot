import { z } from 'zod';
import { id } from './common.js';
import { sessionUser } from './user.js';
import { cartItemInput } from './cart.js';
import { orderStatus } from './order.js';

/** Client posts the raw Telegram `initData` query string for server validation. */
export const authRequest = z.object({
  initData: z.string().min(1),
});
export type AuthRequest = z.infer<typeof authRequest>;

/** Web sign-in of a platform admin: username, password and authenticator code. */
export const webAuthRequest = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  code: z.string().trim().min(6).max(8),
});
export type WebAuthRequest = z.infer<typeof webAuthRequest>;

export const authResponse = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  user: sessionUser,
});
export type AuthResponse = z.infer<typeof authResponse>;

export const addToCartRequest = cartItemInput;
export type AddToCartRequest = z.infer<typeof addToCartRequest>;

export const updateCartItemRequest = z.object({
  quantity: z.number().int().min(0).max(999),
});
export type UpdateCartItemRequest = z.infer<typeof updateCartItemRequest>;

/** Telegram username rules: 5–32 chars, letters, digits and underscores. */
export const telegramUsername = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .regex(
        /^[A-Za-z0-9_]{5,32}$/,
        'Enter a valid Telegram username (5–32 letters, digits or _)',
      ),
  );

/** Checkout details sent when creating an order. */
export const createOrderRequest = z.object({
  contactUsername: telegramUsername,
  /** Required when the shop has active shipping zones. */
  shippingZoneId: z.string().min(1).max(64).optional(),
  /** Address encrypted with the shop's public key; required with a shipping zone. */
  encryptedAddress: z.string().min(1).max(16_000).optional(),
});
export type CreateOrderRequest = z.input<typeof createOrderRequest>;

/** Order is created from the caller's current server-side cart. */
export const createOrderResponse = z.object({
  orderId: id,
});
export type CreateOrderResponse = z.infer<typeof createOrderResponse>;

/** Admin sets the per-order fee (0 hides it) and its label. */
export const updateOrderFeeRequest = z.object({
  orderFee: z.number().int().nonnegative().max(100_000_000),
  orderFeeLabel: z.string().trim().min(1).max(64),
  /** VIPs do not pay the fee (default: keep). */
  vipNoFee: z.boolean().optional(),
});
export type UpdateOrderFeeRequest = z.infer<typeof updateOrderFeeRequest>;

/**
 * Admin moves an order to another status. The customer gets a message from the
 * bot, with the optional note.
 */
export const updateOrderStatusRequest = z.object({
  status: orderStatus,
  /** Message to the customer, added to the bot's notification. */
  note: z.string().trim().max(500).optional(),
  /** Tracking number or link, when shipping. */
  trackingNumber: z.string().trim().max(200).optional(),
  /** Confirm a payment even though tracked stock no longer covers the order. */
  force: z.boolean().optional(),
});
export type UpdateOrderStatusRequest = z.infer<typeof updateOrderStatusRequest>;

/** Which orders an export includes. */
export const exportScope = z.enum([
  'paid',
  'toFulfil',
  'shipped',
  'fulfilled',
  'unpaid',
  'cancelled',
  'all',
]);
export type ExportScope = z.infer<typeof exportScope>;

/** Admin asks the bot to send a report of the shop's orders to their chat. */
export const exportRequest = z.object({
  format: z.enum(['xlsx', 'csv-orders', 'csv-lines']),
  scope: exportScope,
  /** Orders created at or after this instant (ISO). */
  from: z.iso.datetime().optional(),
  /** Orders created before this instant (ISO). */
  to: z.iso.datetime().optional(),
  /** IANA time zone for dates in the file, e.g. Europe/Madrid. */
  timeZone: z.string().max(64).optional(),
});
export type ExportRequest = z.infer<typeof exportRequest>;

/** A file returned to a web administrator (in Telegram, the bot sends it instead). */
export const webFile = z.object({
  fileName: z.string(),
  contentType: z.string(),
  /** Base64. */
  data: z.string(),
});
export type WebFile = z.infer<typeof webFile>;

export const exportResponse = z.object({
  fileName: z.string(),
  orders: z.number().int().nonnegative(),
  file: webFile.optional(),
});
export type ExportResponse = z.infer<typeof exportResponse>;

/** Customer asks to change a paid order: the complete new list of lines. */
export const requestOrderChangeRequest = z.object({
  items: z
    .array(
      z.object({
        productId: id,
        variantId: id.nullable().optional(),
        quantity: z.number().int().positive().max(999),
      }),
    )
    .min(1, 'Keep at least one product (or ask the shop to cancel the order)')
    .max(100),
});
export type RequestOrderChangeRequest = z.infer<typeof requestOrderChangeRequest>;

/** Customer reports a crypto payment: which wallet they paid and the tx hash. */
export const submitPaymentRequest = z.object({
  methodId: z.string().min(1).max(64),
  txHash: z
    .string()
    .trim()
    .min(8, 'Transaction hash looks too short')
    .max(200, 'Transaction hash looks too long')
    .regex(/^[A-Za-z0-9]+$/, 'Paste only the transaction hash (letters and numbers)'),
});
export type SubmitPaymentRequest = z.infer<typeof submitPaymentRequest>;

/** The customer says they paid with a manual method (Wise, Bizum…); an admin checks it. */
export const submitManualPaymentRequest = z.object({
  methodId: z.string().min(1).max(64),
  /** Anything that helps the organiser find the payment (name, transfer id…). */
  reference: z.string().trim().max(200),
});
export type SubmitManualPaymentRequest = z.infer<typeof submitManualPaymentRequest>;

export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiError>;
