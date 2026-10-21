import { and, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  ADMIN_STATUS_CHANGES,
  convertAmount,
  editableDirectly,
  exchangeRateFor,
  type ExchangeRates,
  shippingCost,
  type Order,
  type OrderStatus,
  type OrderChangeRequest,
  type PaymentLogEntry,
} from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { cartItems, orderItems, orders, productVariants, products, shops } from '../db/schema.js';
import { toOrderDTO, variantLabel } from '../db/mappers.js';
import { lineStock, loadVariants, quantitiesByProduct, tieredPrice } from './variants.js';
import { ApiError } from '../lib/errors.js';

type OrderItemRow = typeof orderItems.$inferSelect;
type OrderRow = typeof orders.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Reads an order and locks its row until the transaction ends, so two admin
 * taps at once (confirm, approve, refund) cannot both apply.
 */
async function lockOrder(tx: Tx, where: SQL | undefined): Promise<OrderRow | undefined> {
  const [row] = await tx.select().from(orders).where(where).for('update');
  return row;
}

/** Key of an order or cart line: product plus variant. */
export function lineKey(productId: string, variantId: string | null | undefined): string {
  return `${productId}:${variantId ?? ''}`;
}

export interface DraftLine {
  productId: string;
  variantId?: string | null;
  variantLabel?: string | null;
  title: string;
  /** English version of the title, if the product has one. */
  titleEn?: string | null;
  unitPrice: number;
  quantity: number;
  /** `null` when not stock-tracked. */
  stock: number | null;
}

export interface OrderDraft {
  items: Array<{
    productId: string;
    variantId: string | null;
    variantLabel: string | null;
    title: string;
    titleEn: string | null;
    unitPrice: number;
    quantity: number;
    subtotal: number;
  }>;
  total: number;
}

/**
 * Pure helper: turns resolved cart lines into a priced order draft, validating
 * that the cart is non-empty and every tracked line is within stock. Extracted
 * so the pricing/validation rules can be unit-tested without a database.
 */
export function buildOrderDraft(lines: DraftLine[]): OrderDraft {
  if (lines.length === 0) {
    throw ApiError.badRequest('empty_cart', 'Cannot create an order from an empty cart');
  }
  const items = lines.map((line) => {
    if (line.quantity <= 0) {
      throw ApiError.badRequest('invalid_quantity', `Invalid quantity for "${line.title}"`);
    }
    const name = line.variantLabel ? `${line.title} (${line.variantLabel})` : line.title;
    if (line.stock !== null && line.quantity > line.stock) {
      throw ApiError.conflict('out_of_stock', `Only ${line.stock} of "${name}" in stock`);
    }
    return {
      productId: line.productId,
      variantId: line.variantId ?? null,
      variantLabel: line.variantLabel ?? null,
      title: line.title,
      titleEn: line.titleEn ?? null,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      subtotal: line.unitPrice * line.quantity,
    };
  });
  return { items, total: items.reduce((sum, item) => sum + item.subtotal, 0) };
}

/** Creates an order from the user's current cart inside a single transaction. */
/** Shape of the encrypted address envelope built by the Mini App (not decrypted here). */
interface AddressEnvelope {
  v: number;
  kid: string;
  key: string;
  iv: string;
  data: string;
}

function parseEnvelope(text: string): AddressEnvelope | null {
  try {
    const value = JSON.parse(text) as Partial<AddressEnvelope>;
    const ok =
      value.v === 1 &&
      typeof value.kid === 'string' &&
      typeof value.key === 'string' &&
      typeof value.iv === 'string' &&
      typeof value.data === 'string';
    return ok ? (value as AddressEnvelope) : null;
  } catch {
    return null;
  }
}

export interface CheckoutShipping {
  shippingZoneId?: string | undefined;
  encryptedAddress?: string | undefined;
}

/**
 * A product's minimum counts all its variants together: refuses an order (or
 * a change) with fewer units of it. Leaving a product out entirely is fine.
 */
function assertMinimums(
  products: ReadonlyArray<{ id: string; title: string; minQuantity: number }>,
  quantities: Map<string, number>,
): void {
  for (const product of products) {
    const quantity = quantities.get(product.id) ?? 0;
    if (quantity > 0 && quantity < product.minQuantity) {
      throw ApiError.badRequest(
        'below_minimum',
        `"${product.title}" is sold from ${product.minQuantity} units (you have ${quantity})`,
      );
    }
  }
}

export async function createOrderFromCart(
  db: Database,
  shopId: string,
  userId: number,
  contactUsername: string | null = null,
  checkout: CheckoutShipping = {},
  /** The buyer is a VIP of the GB: VIP prices, and maybe no fee; the order keeps it. */
  isVip = false,
): Promise<Order> {
  return db.transaction(async (tx) => {
    const shop = await tx.query.shops.findFirst({ where: eq(shops.id, shopId) });
    if (!shop) throw ApiError.notFound('Shop not found');

    const cart = await tx.query.carts.findFirst({
      where: (c, { and: andOp, eq: eqOp }) => andOp(eqOp(c.shopId, shopId), eqOp(c.userId, userId)),
    });
    const lines = cart
      ? await tx
          .select({ item: cartItems, product: products })
          .from(cartItems)
          .innerJoin(products, eq(cartItems.productId, products.id))
          .where(eq(cartItems.cartId, cart.id))
      : [];

    // Same as the cart: VIP-only products only for VIPs.
    const activeLines = lines.filter((l) => l.product.isActive && (isVip || !l.product.vipOnly));
    const currencies = new Set(activeLines.map((l) => l.product.currency));
    if (currencies.size > 1) {
      throw ApiError.badRequest(
        'mixed_currency',
        'The cart mixes currencies; remove the items priced in the other token',
      );
    }
    const currency = activeLines[0]?.product.currency ?? shop.currency;

    const variants = await loadVariants(
      tx,
      activeLines.map((l) => l.product.id),
    );
    // Same rule as the cart: lines that no longer match the product are dropped.
    const valid = activeLines.flatMap(({ item, product }) => {
      const variant = item.variantId
        ? (variants.get(product.id)?.find((v) => v.id === item.variantId) ?? null)
        : null;
      if (product.options.length > 0 && (!variant || !variant.isActive)) return [];
      if (product.options.length === 0 && item.variantId) return [];
      return [{ item, product, variant }];
    });
    // Quantity tiers count every unit of a product, across its variants.
    const productQty = quantitiesByProduct(valid.map((v) => v.item));
    assertMinimums(valid.map((v) => v.product), productQty);
    const draftLines: DraftLine[] = valid.map(({ item, product, variant }) => ({
      productId: product.id,
      variantId: variant?.id ?? null,
      variantLabel: variant ? variantLabel(variant.optionValues) : null,
      title: product.title,
      titleEn: product.titleEn,
      unitPrice: tieredPrice(product, variant, productQty.get(product.id) ?? item.quantity, isVip),
      quantity: item.quantity,
      stock: lineStock(product, variant),
    }));
    const draft = buildOrderDraft(draftLines);

    // Shipped shops: a zone and an address encrypted with the shop's current key.
    const zones = shop.shippingZones.filter((z) => z.isActive);
    let shipping = 0;
    let shippingZoneName: string | null = null;
    let encryptedAddress: string | null = null;
    let addressKeyFingerprint: string | null = null;
    if (zones.length > 0) {
      const zone = zones.find((z) => z.id === checkout.shippingZoneId);
      if (!zone) throw ApiError.badRequest('shipping_required', 'Choose a shipping zone');
      if (!shop.addressPublicKey || !shop.addressKeyFingerprint) {
        throw ApiError.conflict(
          'shop_not_ready',
          'This shop cannot take orders with delivery yet. Please try again later.',
        );
      }
      const envelope = checkout.encryptedAddress ? parseEnvelope(checkout.encryptedAddress) : null;
      if (!envelope) throw ApiError.badRequest('address_required', 'Enter your delivery address');
      if (envelope.kid !== shop.addressKeyFingerprint) {
        throw ApiError.conflict(
          'stale_key',
          'The shop updated its security key. Please reopen the shop and try again.',
        );
      }
      shipping = shippingCost(zone, draft.total, isVip && shop.vipNoShipping);
      shippingZoneName = zone.name;
      encryptedAddress = checkout.encryptedAddress ?? null;
      addressKeyFingerprint = envelope.kid;
    }

    // The shop's per-order fee is frozen on the order and charged once (VIPs
    // may be spared it).
    const fee = isVip && shop.vipNoFee ? 0 : shop.orderFee;
    const [order] = await tx
      .insert(orders)
      .values({
        shopId,
        userId,
        status: 'pending',
        isVip,
        total: draft.total + fee + shipping,
        fee,
        shipping,
        shippingZoneName,
        encryptedAddress,
        addressKeyFingerprint,
        currency,
        contactUsername,
      })
      .returning();
    if (!order) throw new Error('Failed to create order');

    await tx.insert(orderItems).values(draft.items.map((item) => ({ orderId: order.id, ...item })));
    if (cart) await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));

    return toOrderDTO(
      order,
      draft.items.map((item) => ({ ...item, id: '', orderId: order.id })),
    );
  });
}

export async function listOrders(db: Database, shopId: string, userId: number): Promise<Order[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.shopId, shopId), eq(orders.userId, userId)))
    .orderBy(desc(orders.createdAt));
  return attachItems(db, rows);
}

export async function getOrder(
  db: Database,
  shopId: string,
  orderId: string,
  userId?: number,
): Promise<Order | undefined> {
  const filters = [eq(orders.shopId, shopId), eq(orders.id, orderId)];
  if (userId !== undefined) filters.push(eq(orders.userId, userId));
  const order = await db.query.orders.findFirst({ where: and(...filters) });
  if (!order) return undefined;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  return toOrderDTO(order, items);
}

export async function listAllOrders(db: Database, shopId: string): Promise<Order[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.shopId, shopId))
    .orderBy(desc(orders.createdAt));
  return attachItems(db, rows);
}

export async function setOrderStatus(
  db: Database,
  shopId: string,
  orderId: string,
  status: Order['status'],
): Promise<Order> {
  const [updated] = await db
    .update(orders)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(orders.shopId, shopId), eq(orders.id, orderId)))
    .returning();
  if (!updated) throw ApiError.notFound('Order not found');
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, updated.id));
  return toOrderDTO(updated, items);
}

/**
 * Confirms the payment currently under review (or, when the organiser marks it
 * paid by hand, whatever is still due): adds it to `amountPaid`, logs it, and
 * decrements tracked stock the first time an order is paid. Idempotent for
 * orders that are not waiting for a payment.
 */
export async function markOrderPaid(
  db: Database,
  orderId: string,
  /** Transaction (or "manual") recorded in the payment log. */
  reference: string,
  options: {
    /** Refuse (409 `stock_short`) when tracked stock no longer covers the items. */
    checkStock?: boolean;
    /** Message from the shop to the customer. */
    note?: string | null;
    /** Amount actually received (from the on-chain check), in minor units of the order's currency. */
    received?: number;
    /** Paid in the other token: what arrived, in minor units of that token. */
    receivedInToken?: number;
  } = {},
): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, eq(orders.id, orderId));
    if (!order) throw ApiError.notFound('Order not found');

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    if (order.status !== 'pending' && order.status !== 'awaiting_payment') {
      return toOrderDTO(order, items);
    }
    if (options.checkStock && !order.stockApplied) {
      const short = await stockShortages(tx, items);
      if (short.length > 0) {
        throw ApiError.conflict(
          'stock_short',
          `Not enough stock for this order: ${short.join('; ')}. Confirm anyway, or reject the payment.`,
        );
      }
    }

    const received =
      options.received ??
      (order.amountSubmitted > 0 ? order.amountSubmitted : Math.max(order.total - order.amountPaid, 0));
    const amountPaid = order.amountPaid + received;
    const exchange = order.paymentExchange;
    const entry: PaymentLogEntry = {
      type: 'payment',
      amount: received,
      ...(exchange
        ? {
            paid: {
              amount: options.receivedInToken ?? convertAmount(received, exchange.rate),
              token: exchange.token,
              rate: exchange.rate,
            },
          }
        : {}),
      network: order.paymentNetwork,
      txHash: order.paymentTxHash ?? reference,
      at: new Date().toISOString(),
    };

    const [updated] = await tx
      .update(orders)
      .set({
        status: amountPaid >= order.total ? 'paid' : 'pending',
        amountPaid,
        amountSubmitted: 0,
        paymentExchange: null,
        paymentLog: [...order.paymentLog, entry],
        stockApplied: true,
        statusNote: options.note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id))
      .returning();
    if (!updated) throw new Error('Failed to update order');

    if (!order.stockApplied) await takeStock(tx, items);

    return toOrderDTO(updated, items);
  });
}

/** Takes an order's items out of tracked stock (never below 0). */
async function takeStock(tx: Tx, items: OrderItemRow[]): Promise<void> {
  for (const item of items) {
    if (item.variantId) {
      await tx
        .update(productVariants)
        .set({ stock: sql`GREATEST(${productVariants.stock} - ${item.quantity}, 0)` })
        .where(
          and(eq(productVariants.id, item.variantId), sql`${productVariants.stock} IS NOT NULL`),
        );
    } else {
      await tx
        .update(products)
        .set({ stock: sql`GREATEST(${products.stock} - ${item.quantity}, 0)` })
        .where(and(eq(products.id, item.productId), sql`${products.stock} IS NOT NULL`));
    }
  }
}

/** Items whose tracked stock is below what the order needs, as readable lines. */
async function stockShortages(tx: Tx, items: OrderItemRow[]): Promise<string[]> {
  const needed = new Map<string, { item: OrderItemRow; quantity: number }>();
  for (const item of items) {
    const key = lineKey(item.productId, item.variantId);
    const prev = needed.get(key);
    needed.set(key, { item, quantity: (prev?.quantity ?? 0) + item.quantity });
  }
  const variantIds = items.flatMap((i) => (i.variantId ? [i.variantId] : []));
  const productIds = items.map((i) => i.productId);
  const variantRows =
    variantIds.length > 0
      ? await tx.select().from(productVariants).where(inArray(productVariants.id, variantIds))
      : [];
  const productRows = await tx.select().from(products).where(inArray(products.id, productIds));

  const short: string[] = [];
  for (const { item, quantity } of needed.values()) {
    const stock = item.variantId
      ? variantRows.find((v) => v.id === item.variantId)?.stock
      : productRows.find((p) => p.id === item.productId)?.stock;
    if (stock === null || stock === undefined || stock >= quantity) continue;
    const name = item.variantLabel ? `${item.title} (${item.variantLabel})` : item.title;
    short.push(`${name}: ${stock} left, order needs ${quantity}`);
  }
  return short;
}

/** Puts an order's items back into tracked stock (when it is cancelled). */
async function restoreStock(tx: Tx, items: OrderItemRow[]): Promise<void> {
  for (const item of items) {
    if (item.variantId) {
      await tx
        .update(productVariants)
        .set({ stock: sql`${productVariants.stock} + ${item.quantity}` })
        .where(
          and(eq(productVariants.id, item.variantId), sql`${productVariants.stock} IS NOT NULL`),
        );
    } else {
      await tx
        .update(products)
        .set({ stock: sql`${products.stock} + ${item.quantity}` })
        .where(and(eq(products.id, item.productId), sql`${products.stock} IS NOT NULL`));
    }
  }
}

export interface StatusChange {
  status: OrderStatus;
  note?: string | undefined;
  trackingNumber?: string | undefined;
  force?: boolean | undefined;
}

/**
 * An admin moves an order to another status (see `ADMIN_STATUS_CHANGES`):
 *  - `paid`: confirms the payment (checks stock unless `force`);
 *  - `pending` from `awaiting_payment`: rejects the submitted payment;
 *  - `shipped`: with an optional tracking number;
 *  - `cancelled`: returns held stock; anything paid becomes a refund owed.
 * Returns the order and the status it had before.
 */
export async function changeOrderStatus(
  db: Database,
  shopId: string,
  orderId: string,
  change: StatusChange,
): Promise<{ order: Order; previous: OrderStatus }> {
  const where = and(eq(orders.shopId, shopId), eq(orders.id, orderId));
  const row = await db.query.orders.findFirst({ where });
  if (!row) throw ApiError.notFound('Order not found');
  const previous = row.status;
  if (!ADMIN_STATUS_CHANGES[previous].includes(change.status)) {
    throw ApiError.conflict(
      'bad_status_change',
      `An order that is ${previous} cannot be set to ${change.status}`,
    );
  }
  const note = change.note?.trim() || null;

  if (change.status === 'paid') {
    const order = await markOrderPaid(db, orderId, row.paymentTxHash ?? 'manual', {
      checkStock: !change.force,
      note,
    });
    return { order, previous };
  }

  const order = await db.transaction(async (tx) => {
    const locked = await lockOrder(tx, where);
    if (!locked) throw ApiError.notFound('Order not found');
    if (locked.status !== previous) {
      throw ApiError.conflict('order_changed', 'The order changed meanwhile. Reload it.');
    }
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, locked.id));

    const now = new Date();
    const set: Partial<typeof orders.$inferInsert> = {
      status: change.status,
      statusNote: note,
      updatedAt: now,
    };
    // Retention counts from the moment the order is closed.
    if (change.status === 'fulfilled' || change.status === 'cancelled') set.closedAt = now;
    if (change.status === 'pending') {
      // Payment rejected: the customer can send a (correct) transaction again.
      set.paymentTxHash = null;
      set.paymentNetwork = null;
      set.paymentMethodId = null;
      set.paymentCheck = null;
      set.amountSubmitted = 0;
      // Give back the stock reserved by that payment (not stock already paid for).
      if (locked.stockApplied && locked.amountPaid === 0) {
        await restoreStock(tx, items);
        set.stockApplied = false;
      }
    }
    if (change.status === 'shipped') {
      set.trackingNumber = change.trackingNumber?.trim() || null;
    }
    if (change.status === 'cancelled') {
      set.changeRequest = null;
      set.amountSubmitted = 0;
      if (locked.stockApplied) {
        await restoreStock(tx, items);
        set.stockApplied = false;
      }
    }

    const [updated] = await tx.update(orders).set(set).where(eq(orders.id, locked.id)).returning();
    if (!updated) throw new Error('Failed to update order');
    return toOrderDTO(updated, items);
  });
  return { order, previous };
}

/**
 * Records a crypto payment reported by the customer: the wallet they paid into
 * and the transaction hash. Moves the order to `awaiting_payment` so an admin
 * can verify it on-chain and confirm it manually. The customer may resubmit
 * (e.g. to fix a typo) until an admin confirms the payment.
 */
export async function submitCryptoPayment(
  db: Database,
  shopId: string,
  orderId: string,
  userId: number,
  paymentNetwork: string,
  /** Transaction hash; for manual methods, the customer's reference (or null). */
  txHash: string | null,
  paymentMethodId: string | null = null,
  /** A manual method (Wise, Bizum…): nothing to check on-chain, and references may repeat. */
  manual = false,
  /** Crypto: the token paid and the shop's exchange rates (to pay in the other token). */
  crypto: { token: string; rates: ExchangeRates | undefined } | null = null,
): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(
      tx,
      and(eq(orders.shopId, shopId), eq(orders.id, orderId), eq(orders.userId, userId)),
    );
    if (!order) throw ApiError.notFound('Order not found');
    if (order.status !== 'pending' && order.status !== 'awaiting_payment') {
      throw ApiError.conflict('not_payable', `Order is ${order.status} and cannot take a payment`);
    }
    const due = order.total - order.amountPaid;
    if (due <= 0) throw ApiError.conflict('nothing_due', 'Nothing is left to pay for this order');
    // Paying in the other token: only at a rate the shop set, frozen for this payment.
    let paymentExchange: { token: string; rate: number } | null = null;
    if (crypto && crypto.token !== order.currency) {
      const rate = exchangeRateFor(crypto.rates, order.currency, crypto.token);
      if (rate === null) {
        throw ApiError.badRequest('no_exchange', `This order can only be paid in ${order.currency}`);
      }
      paymentExchange = { token: crypto.token, rate };
    }

    // A transaction can only pay once: not for another order, and not twice here.
    const reused =
      manual || txHash === null
        ? undefined
        : await tx.query.orders.findFirst({
      where: or(
        and(eq(orders.paymentTxHash, txHash), ne(orders.id, order.id)),
        sql`${orders.paymentLog} @> ${JSON.stringify([{ txHash }])}::jsonb`,
      ),
    });
    if (reused) {
      throw ApiError.conflict('tx_already_used', 'This transaction was already used for a payment');
    }

    // Reserve the stock now that the customer says they paid, so nobody else
    // can buy the same units while the payment is checked. If it is already
    // short, the payment is still recorded and the admin is warned on confirm.
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    let stockApplied = order.stockApplied;
    if (!stockApplied && (await stockShortages(tx, items)).length === 0) {
      await takeStock(tx, items);
      stockApplied = true;
    }

    const [updated] = await tx
      .update(orders)
      .set({
        status: 'awaiting_payment',
        paymentNetwork,
        paymentTxHash: txHash,
        paymentMethodId,
        // The on-chain check starts right after (manual methods: an admin checks).
        paymentCheck:
          paymentMethodId && !manual
            ? { status: 'checking', reason: null, vars: null, at: new Date().toISOString() }
            : null,
        amountSubmitted: due,
        paymentExchange,
        stockApplied,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id))
      .returning();
    if (!updated) throw new Error('Failed to update order');
    return toOrderDTO(updated, items);
  });
}

/** Statuses a customer may delete: nothing paid or under verification. */
const CUSTOMER_DELETABLE: Order['status'][] = ['pending', 'cancelled'];

/**
 * Deletes an order (its items cascade). Admins (no `userId`) may delete any
 * order; customers only their own, and only while nothing has been paid or
 * submitted for verification, so a payment never loses its record.
 */
export async function deleteOrder(
  db: Database,
  shopId: string,
  orderId: string,
  userId?: number,
): Promise<void> {
  const filters = [eq(orders.shopId, shopId), eq(orders.id, orderId)];
  if (userId !== undefined) filters.push(eq(orders.userId, userId));
  const order = await db.query.orders.findFirst({ where: and(...filters) });
  if (!order) throw ApiError.notFound('Order not found');

  const moneyInvolved = order.amountPaid > 0 || order.amountSubmitted > 0;
  if (userId !== undefined && (!CUSTOMER_DELETABLE.includes(order.status) || moneyInvolved)) {
    throw ApiError.conflict(
      'not_deletable',
      'Orders with a submitted or confirmed payment cannot be deleted. Contact the shop.',
    );
  }

  await db.transaction(async (tx) => {
    // Stock reserved by a payment that was never confirmed goes back.
    if (order.stockApplied && order.amountPaid === 0 && order.status !== 'cancelled') {
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      await restoreStock(tx, items);
    }
    await tx.delete(orders).where(eq(orders.id, order.id));
  });
}

/** Orders a customer may ask to modify: already paid or under verification. */
const CHANGEABLE: Order['status'][] = ['paid', 'awaiting_payment'];

/**
 * Stores a customer's requested modification (the full new item list) for
 * admin approval. Lines already in the order keep their original unit price;
 * new products use the current price. Stock is checked against what the order
 * already holds. Replaces any earlier pending request.
 */
export async function requestOrderChange(
  db: Database,
  shopId: string,
  orderId: string,
  userId: number,
  lines: Array<{ productId: string; variantId?: string | null | undefined; quantity: number }>,
): Promise<Order> {
  const order = await db.query.orders.findFirst({
    where: and(eq(orders.shopId, shopId), eq(orders.id, orderId), eq(orders.userId, userId)),
  });
  if (!order) throw ApiError.notFound('Order not found');
  const direct = editableDirectly(order);
  if (!direct && !CHANGEABLE.includes(order.status)) {
    throw ApiError.conflict(
      'not_changeable',
      'Only paid orders, or orders whose payment is being verified, can be changed',
    );
  }

  const current = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const currentQty = new Map(current.map((i) => [lineKey(i.productId, i.variantId), i.quantity]));
  const currentPrice = new Map(
    current.map((i) => [lineKey(i.productId, i.variantId), i.unitPrice]),
  );

  // Merge duplicate lines.
  const wanted = new Map<string, { productId: string; variantId: string | null; quantity: number }>();
  for (const line of lines) {
    const variantId = line.variantId ?? null;
    const key = lineKey(line.productId, variantId);
    const prev = wanted.get(key);
    wanted.set(key, {
      productId: line.productId,
      variantId,
      quantity: (prev?.quantity ?? 0) + line.quantity,
    });
  }

  const productIds = [...new Set([...wanted.values()].map((w) => w.productId))];
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.shopId, shopId), inArray(products.id, productIds)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const variants = await loadVariants(db, productIds);

  const oldProductQty = quantitiesByProduct(current);
  const newProductQty = quantitiesByProduct([...wanted.values()]);
  // Only products whose quantity changes (a minimum raised later does not
  // block changing something else).
  assertMinimums(
    rows.filter((row) => newProductQty.get(row.id) !== oldProductQty.get(row.id)),
    newProductQty,
  );

  const items: OrderChangeRequest['items'] = [];
  for (const [key, { productId, variantId, quantity }] of wanted) {
    const product = byId.get(productId);
    const inOrder = currentQty.has(key);
    if (!product || (!inOrder && (!product.isActive || (product.vipOnly && !order.isVip)))) {
      throw ApiError.badRequest('unknown_product', 'A product in the change is no longer available');
    }
    const variant = variantId
      ? (variants.get(productId)?.find((v) => v.id === variantId) ?? null)
      : null;
    if (product.options.length > 0 && (!variant || (!inOrder && !variant.isActive))) {
      throw ApiError.badRequest('variant_required', `Choose an available option for "${product.title}"`);
    }
    if (product.options.length === 0 && variantId) {
      throw ApiError.badRequest('no_variants', `"${product.title}" has no options`);
    }
    if (product.currency !== order.currency) {
      throw ApiError.badRequest(
        'mixed_currency',
        `"${product.title}" is priced in ${product.currency}; this order is in ${order.currency}`,
      );
    }
    const label = variant ? variantLabel(variant.optionValues) : null;
    const stock = lineStock(product, variant);
    const held = order.stockApplied ? (currentQty.get(key) ?? 0) : 0;
    if (stock !== null && quantity > stock + held) {
      throw ApiError.conflict(
        'out_of_stock',
        `Only ${stock + held} of "${label ? `${product.title} (${label})` : product.title}" available`,
      );
    }
    // A product whose total quantity is unchanged keeps the prices paid; when it
    // changes, every line of it is priced again with the current tiers.
    const unitPrice =
      newProductQty.get(productId) === oldProductQty.get(productId)
        ? (currentPrice.get(key) ??
          tieredPrice(product, variant, newProductQty.get(productId) ?? quantity, order.isVip))
        : tieredPrice(product, variant, newProductQty.get(productId) ?? quantity, order.isVip);
    items.push({
      productId,
      variantId: variant?.id ?? null,
      variantLabel: label,
      title: product.title,
      titleEn: product.titleEn,
      unitPrice,
      quantity,
      subtotal: unitPrice * quantity,
    });
  }

  const unchanged =
    items.length === current.length &&
    items.every((item) => currentQty.get(lineKey(item.productId, item.variantId)) === item.quantity);
  if (unchanged) throw ApiError.badRequest('no_changes', 'The order is unchanged');

  // Nothing paid yet: the change applies at once, no approval needed.
  if (direct) return applyUnpaidEdit(db, shopId, order.id, items);

  const changeRequest: OrderChangeRequest = {
    items,
    // Fee and shipping stay the same: they are charged once per order.
    total: items.reduce((sum, item) => sum + item.subtotal, 0) + order.fee + order.shipping,
    requestedAt: new Date().toISOString(),
  };
  const [updated] = await db
    .update(orders)
    .set({ changeRequest, updatedAt: new Date() })
    .where(eq(orders.id, order.id))
    .returning();
  if (!updated) throw new Error('Failed to update order');
  return toOrderDTO(updated, current);
}

/**
 * Replaces the items of an order with nothing paid and no payment sent. The
 * total is worked out again (shipping too, in case the order now reaches or
 * drops below free shipping), the auto-cancel countdown starts again, and a
 * new payment reminder can be sent later. No stock is held by such an order.
 */
async function applyUnpaidEdit(
  db: Database,
  shopId: string,
  orderId: string,
  items: OrderChangeRequest['items'],
): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, and(eq(orders.shopId, shopId), eq(orders.id, orderId)));
    if (!order) throw ApiError.notFound('Order not found');
    if (!editableDirectly(order)) {
      throw ApiError.conflict('order_changed', 'The order changed meanwhile. Reload it.');
    }
    const itemsTotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    let shipping = order.shipping;
    if (order.shippingZoneName) {
      const shop = await tx.query.shops.findFirst({ where: eq(shops.id, shopId) });
      const zone = shop?.shippingZones.find((z) => z.name === order.shippingZoneName);
      if (zone) shipping = shippingCost(zone, itemsTotal, order.isVip && (shop?.vipNoShipping ?? false));
    }

    await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
    const inserted = await tx
      .insert(orderItems)
      .values(
        items.map((item) => ({
          orderId: order.id,
          ...item,
          variantId: item.variantId ?? null,
          variantLabel: item.variantLabel ?? null,
          titleEn: item.titleEn ?? null,
        })),
      )
      .returning();
    const [updated] = await tx
      .update(orders)
      .set({
        total: itemsTotal + order.fee + shipping,
        shipping,
        changeRequest: null,
        paymentReminderAt: null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id))
      .returning();
    if (!updated) throw new Error('Failed to update order');
    return toOrderDTO(updated, inserted);
  });
}

/** Withdraws (customer) or rejects (admin, no `userId`) a pending change. */
export async function clearOrderChange(
  db: Database,
  shopId: string,
  orderId: string,
  userId?: number,
): Promise<Order> {
  const filters = [eq(orders.shopId, shopId), eq(orders.id, orderId)];
  if (userId !== undefined) filters.push(eq(orders.userId, userId));
  const [updated] = await db
    .update(orders)
    .set({ changeRequest: null, updatedAt: new Date() })
    .where(and(...filters))
    .returning();
  if (!updated) throw ApiError.notFound('Order not found');
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, updated.id));
  return toOrderDTO(updated, items);
}

/**
 * Applies an approved change: replaces the items and total, moves tracked stock
 * by the difference (when the order already holds stock) and works out what is
 * owed. A paid order that now costs more goes back to `pending` so the customer
 * can pay the difference; one that costs less stays paid with a refund due.
 */
export async function approveOrderChange(
  db: Database,
  shopId: string,
  orderId: string,
): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, and(eq(orders.shopId, shopId), eq(orders.id, orderId)));
    if (!order) throw ApiError.notFound('Order not found');
    const change = order.changeRequest;
    if (!change) throw ApiError.conflict('no_change', 'There is no change to approve');
    if (!CHANGEABLE.includes(order.status)) {
      throw ApiError.conflict('not_changeable', `Order is ${order.status} and cannot be changed`);
    }

    const current = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));

    if (order.stockApplied) {
      const delta = new Map<string, { productId: string; variantId: string | null; diff: number }>();
      const bump = (productId: string, variantId: string | null, by: number): void => {
        const key = lineKey(productId, variantId);
        const prev = delta.get(key);
        delta.set(key, { productId, variantId, diff: (prev?.diff ?? 0) + by });
      };
      for (const item of current) bump(item.productId, item.variantId, -item.quantity);
      for (const item of change.items) bump(item.productId, item.variantId ?? null, item.quantity);

      for (const { productId, variantId, diff } of delta.values()) {
        if (diff === 0) continue;
        if (variantId) {
          const variant = await tx.query.productVariants.findFirst({
            where: eq(productVariants.id, variantId),
          });
          if (!variant || variant.stock === null) continue;
          if (diff > variant.stock) {
            throw ApiError.conflict(
              'out_of_stock',
              `Not enough stock of "${variantLabel(variant.optionValues)}" (${variant.stock} left) to approve`,
            );
          }
          await tx
            .update(productVariants)
            .set({ stock: variant.stock - diff })
            .where(eq(productVariants.id, variantId));
        } else {
          const product = await tx.query.products.findFirst({ where: eq(products.id, productId) });
          if (!product || product.stock === null) continue;
          if (diff > product.stock) {
            throw ApiError.conflict(
              'out_of_stock',
              `Not enough stock of "${product.title}" (${product.stock} left) to approve`,
            );
          }
          await tx
            .update(products)
            .set({ stock: product.stock - diff })
            .where(eq(products.id, productId));
        }
      }
    }

    await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
    const inserted = await tx
      .insert(orderItems)
      .values(
        change.items.map((item) => ({
          orderId: order.id,
          ...item,
          variantId: item.variantId ?? null,
          variantLabel: item.variantLabel ?? null,
          titleEn: item.titleEn ?? null,
        })),
      )
      .returning();

    const status =
      order.status === 'paid' && change.total > order.amountPaid ? 'pending' : order.status;
    const [updated] = await tx
      .update(orders)
      .set({ total: change.total, changeRequest: null, status, updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();
    if (!updated) throw new Error('Failed to update order');
    return toOrderDTO(updated, inserted);
  });
}

/** Records that the admin sent back the overpaid amount (`amountPaid > total`). */
export async function recordRefund(db: Database, shopId: string, orderId: string): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, and(eq(orders.shopId, shopId), eq(orders.id, orderId)));
    if (!order) throw ApiError.notFound('Order not found');
    // A cancelled order keeps nothing: all that was paid goes back.
    const kept = order.status === 'cancelled' ? 0 : order.total;
    const refund = order.amountPaid - kept;
    if (refund <= 0) throw ApiError.conflict('nothing_to_refund', 'Nothing is owed to the customer');

    const entry: PaymentLogEntry = {
      type: 'refund',
      amount: refund,
      network: null,
      txHash: null,
      at: new Date().toISOString(),
    };
    const [updated] = await tx
      .update(orders)
      .set({
        amountPaid: kept,
        paymentLog: [...order.paymentLog, entry],
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id))
      .returning();
    if (!updated) throw new Error('Failed to update order');
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, updated.id));
    return toOrderDTO(updated, items);
  });
}

/** Adds the items to each order, with one query for all of them. */
async function attachItems(db: Database, rows: OrderRow[]): Promise<Order[]> {
  if (rows.length === 0) return [];
  const items = await db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((row) => row.id)));
  const byOrder = new Map<string, OrderItemRow[]>();
  for (const item of items) {
    const list = byOrder.get(item.orderId);
    if (list) list.push(item);
    else byOrder.set(item.orderId, [item]);
  }
  return rows.map((row) => toOrderDTO(row, byOrder.get(row.id) ?? []));
}
