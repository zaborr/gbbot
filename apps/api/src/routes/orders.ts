import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  createOrderRequest,
  isClosedAt,
  MANUAL_METHOD_PREFIX,
  manualMethodsOf,
  paymentMethodsOf,
  submitManualPaymentRequest,
  requestOrderChangeRequest,
  submitPaymentRequest,
  type CreateOrderResponse,
} from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { requireAuth, requireTelegramUser } from '../auth/middleware.js';
import {
  createOrderFromCart,
  deleteOrder,
  getOrder,
  clearOrderChange,
  listOrders,
  requestOrderChange,
  submitCryptoPayment,
} from '../services/orders.js';
import { buildChangeRequestMessage, buildPaymentReviewMessage } from '../services/notifications.js';
import { describeCustomer } from '../services/customers.js';
import { startPaymentCheck } from '../services/paymentCheck.js';
import { EVM_TX_RE } from '../chain/evm.js';
import { SOLANA_SIGNATURE_RE } from '../chain/solana.js';
import { paymentMethodLabel } from '../config/payment-methods.js';
import { notifyShopTeam } from '../services/webNotices.js';
import { ApiError } from '../lib/errors.js';
import { assertOpen } from '../services/closing.js';

const idParam = z.object({ id: z.uuid() });

export function orderRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireTelegramUser);

  app.post('/', zValidator('json', createOrderRequest), async (c) => {
    const { sub } = c.get('claims');
    const { contactUsername, shippingZoneId, encryptedAddress } = c.req.valid('json');
    assertOpen(c.get('shop'));
    const order = await createOrderFromCart(
      c.get('db'),
      c.get('shopId'),
      sub,
      contactUsername ?? null,
      { shippingZoneId, encryptedAddress },
      c.get('isVip'),
    );
    const response: CreateOrderResponse = { orderId: order.id };
    return c.json(response, 201);
  });

  app.get('/', async (c) => {
    const { sub } = c.get('claims');
    return c.json(await listOrders(c.get('db'), c.get('shopId'), sub));
  });

  app.get('/:id', zValidator('param', idParam), async (c) => {
    const { sub } = c.get('claims');
    const order = await getOrder(c.get('db'), c.get('shopId'), c.req.valid('param').id, sub);
    if (!order) throw ApiError.notFound('Order not found');
    return c.json(order);
  });

  app.delete('/:id', zValidator('param', idParam), async (c) => {
    const { sub } = c.get('claims');
    await deleteOrder(c.get('db'), c.get('shopId'), c.req.valid('param').id, sub);
    return c.body(null, 204);
  });

  // Customer reports a crypto payment (wallet + tx hash) for manual review.
  app.post(
    '/:id/payment',
    zValidator('param', idParam),
    zValidator('json', submitPaymentRequest),
    async (c) => {
      const { sub } = c.get('claims');
      const env = c.get('env');
      const db = c.get('db');
      const { methodId, txHash } = c.req.valid('json');

      const method = paymentMethodsOf(c.get('shop').paymentSetup).find((m) => m.id === methodId);
      if (!method) throw ApiError.badRequest('unknown_method', 'Unknown payment method');
      const validHash = method.chain === 'solana' ? SOLANA_SIGNATURE_RE : EVM_TX_RE;
      if (!validHash.test(txHash)) {
        throw ApiError.badRequest(
          'invalid_tx',
          method.chain === 'solana'
            ? 'That is not a Solana transaction signature'
            : 'That is not a transaction hash (0x followed by 64 characters)',
        );
      }

      // A closed GB still takes the difference left on a paid order, but not
      // the payment of an order with nothing paid (it is removed on closing).
      if (isClosedAt(c.get('shop'))) {
        const current = await getOrder(db, c.get('shopId'), c.req.valid('param').id, sub);
        if (current && current.amountPaid === 0) assertOpen(c.get('shop'));
      }

      const order = await submitCryptoPayment(
        db,
        c.get('shopId'),
        c.req.valid('param').id,
        sub,
        paymentMethodLabel(method),
        txHash,
        method.id,
        false,
        { token: method.token, rates: c.get('shop').paymentSetup?.exchange },
      );

      // Checked on the blockchain in the background; admins hear about it
      // when it is confirmed, or when it needs them.
      startPaymentCheck(db, env, order.id);

      return c.json(order);
    },
  );

  // Customer says they paid with a manual method (Wise, Bizum…): an admin checks it.
  app.post(
    '/:id/manual-payment',
    zValidator('param', idParam),
    zValidator('json', submitManualPaymentRequest),
    async (c) => {
      const { sub } = c.get('claims');
      const env = c.get('env');
      const db = c.get('db');
      const shop = c.get('shop');
      const { methodId, reference } = c.req.valid('json');

      const method = manualMethodsOf(shop.paymentSetup).find((m) => m.id === methodId);
      if (!method) throw ApiError.badRequest('unknown_method', 'Unknown payment method');

      if (isClosedAt(shop)) {
        const current = await getOrder(db, shop.id, c.req.valid('param').id, sub);
        if (current && current.amountPaid === 0) assertOpen(shop);
      }

      const order = await submitCryptoPayment(
        db,
        shop.id,
        c.req.valid('param').id,
        sub,
        method.name,
        reference === '' ? null : reference,
        `${MANUAL_METHOD_PREFIX}${method.id}`,
        true,
      );

      // Nothing to check on-chain: the admins hear about it now.
      const customer = await describeCustomer(db, sub);
      await notifyShopTeam(db, env, shop, (lang) =>
        buildPaymentReviewMessage(lang, order, customer),
      );
      return c.json(order);
    },
  );

  // Customer modifies an order. Unpaid ones change at once; paid ones (or with
  // a payment under review) become a request the organiser must approve.
  app.post(
    '/:id/change',
    zValidator('param', idParam),
    zValidator('json', requestOrderChangeRequest),
    async (c) => {
      const { sub } = c.get('claims');
      const env = c.get('env');
      const db = c.get('db');
      assertOpen(c.get('shop'));
      const order = await requestOrderChange(
        db,
        c.get('shopId'),
        c.req.valid('param').id,
        sub,
        c.req.valid('json').items,
      );
      if (order.changeRequest) {
        const customer = await describeCustomer(db, sub);
        await notifyShopTeam(db, env, c.get('shop'), (lang) =>
          buildChangeRequestMessage(lang, order, customer),
        );
      }
      return c.json(order);
    },
  );

  // Customer withdraws their pending change request.
  app.delete('/:id/change', zValidator('param', idParam), async (c) => {
    const { sub } = c.get('claims');
    return c.json(
      await clearOrderChange(c.get('db'), c.get('shopId'), c.req.valid('param').id, sub),
    );
  });

  return app;
}
