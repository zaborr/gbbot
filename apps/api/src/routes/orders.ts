import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  addDonationRequest,
  extraRoundRequest,
  joinExternalRequest,
  extraSignupRequest,
  addOrderDetailsRequest,
  cartTestingRequest,
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
  addOrderDetails,
  createOrderFromCart,
  deleteOrder,
  getOrder,
  clearOrderChange,
  listOrders,
  requestOrderChange,
  submitCryptoPayment,
} from '../services/orders.js';
import {
  buildChangeRequestMessage,
  buildDetailsAddedMessage,
  buildPaymentReviewMessage,
} from '../services/notifications.js';
import { describeCustomer } from '../services/customers.js';
import { startPaymentCheck } from '../services/paymentCheck.js';
import { EVM_TX_RE } from '../chain/evm.js';
import { SOLANA_SIGNATURE_RE } from '../chain/solana.js';
import { paymentMethodLabel } from '../config/payment-methods.js';
import { notifyShopTeam } from '../services/webNotices.js';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { assertOpen } from '../services/closing.js';
import { joinTestingExternal, joinTestingWithOrder, setVolunteer } from '../services/testing.js';
import { addDonation, removeDonation, tellJoined } from '../services/testingDonations.js';
import { leaveExtra, answerRound, signUpExtra } from '../services/testingExtra.js';

const idParam = z.object({ id: z.uuid() });

export function orderRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireTelegramUser);

  app.post('/', zValidator('json', createOrderRequest), async (c) => {
    const { sub } = c.get('claims');
    const { contactUsername, shippingZoneId, encryptedAddress } = c.req.valid('json');
    assertOpen(c.get('shop'));
    // A security phrase first: it is how the customer tells the official bot from a fake one.
    const customer = await c.get('db').query.users.findFirst({ where: eq(users.telegramId, sub) });
    if (!customer?.securityPhrase) {
      throw ApiError.conflict('security_phrase', 'Choose your security phrase before ordering');
    }
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

  // Joining a testing from outside (bought elsewhere): an order of only the fee.
  app.post('/external-testing/:id', zValidator('param', idParam), zValidator('json', joinExternalRequest), async (c) => {
    const { sub } = c.get('claims');
    const testingId = c.req.valid('param').id;
    const orderId = await joinTestingExternal(
      c.get('db'),
      c.get('shop'),
      sub,
      testingId,
      c.req.valid('json'),
      c.get('isVip') || c.get('canManage'),
    );
    void tellJoined(c.get('db'), c.get('env'), c.get('shop'), sub, orderId, testingId).catch((error: unknown) =>
      console.error('Joined notice failed:', error),
    );
    const response: CreateOrderResponse = { orderId };
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
        // From outside: only the testing, which takes people after closing.
        if (current && current.amountPaid === 0 && !current.external) assertOpen(c.get('shop'));
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
        if (current && current.amountPaid === 0 && !current.external) assertOpen(shop);
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

  // Giving to a testing once the GB is closed: a line added to the order, paid the usual way.
  app.post('/:id/donations', zValidator('param', idParam), zValidator('json', addDonationRequest), async (c) => {
    const { testingId, amount } = c.req.valid('json');
    return c.json(
      await addDonation(c.get('db'), c.get('shop'), c.get('claims').sub, c.req.valid('param').id, testingId, amount),
    );
  });
  app.delete(
    '/:id/donations/:testingId',
    zValidator('param', z.object({ id: z.uuid(), testingId: z.uuid() })),
    async (c) => {
      const { id, testingId } = c.req.valid('param');
      return c.json(await removeDonation(c.get('db'), c.get('shop'), c.get('claims').sub, id, testingId));
    },
  );

  // The extra round of a testing: signing up with a cap, or leaving, while sign-up is open.
  app.post('/:id/extra', zValidator('param', idParam), zValidator('json', extraSignupRequest), async (c) => {
    const { testingId, cap } = c.req.valid('json');
    return c.json(await signUpExtra(c.get('db'), c.get('shop'), c.get('claims').sub, c.req.valid('param').id, testingId, cap));
  });
  app.delete(
    '/:id/extra/:testingId',
    zValidator('param', z.object({ id: z.uuid(), testingId: z.uuid() })),
    async (c) => {
      const { id, testingId } = c.req.valid('param');
      return c.json(await leaveExtra(c.get('db'), c.get('shop'), c.get('claims').sub, id, testingId));
    },
  );

  // The second round of the extra one: going on (paying the difference) or leaving (all back).
  app.post('/:id/extra/round', zValidator('param', idParam), zValidator('json', extraRoundRequest), async (c) => {
    const { testingId, stay } = c.req.valid('json');
    return c.json(await answerRound(c.get('db'), c.get('shop'), c.get('claims').sub, c.req.valid('param').id, testingId, stay));
  });

  // Joining a product testing with an order already placed (the contribution is added to it).
  app.post('/:id/testings', zValidator('param', idParam), zValidator('json', cartTestingRequest), async (c) => {
    const { sub } = c.get('claims');
    const { id } = c.req.valid('param');
    const { testingId, volunteer } = c.req.valid('json');
    // An open testing (open GB), or one made after closing while its time lasts: checked there.
    await joinTestingWithOrder(c.get('db'), c.get('shop'), sub, id, testingId, volunteer);
    void tellJoined(c.get('db'), c.get('env'), c.get('shop'), sub, id, testingId).catch((error: unknown) =>
      console.error('Joined notice failed:', error),
    );
    const order = await getOrder(c.get('db'), c.get('shopId'), id, sub);
    if (!order) throw ApiError.notFound('Order not found');
    return c.json(order);
  });

  // Offering a vial in one testing (or not), until its draw.
  app.put(
    '/:id/testings/:testingId/volunteer',
    zValidator('param', z.object({ id: z.uuid(), testingId: z.uuid() })),
    zValidator('json', z.object({ volunteer: z.boolean() })),
    async (c) => {
      const { id, testingId } = c.req.valid('param');
      await setVolunteer(c.get('db'), c.get('shopId'), c.get('claims').sub, id, testingId, c.req.valid('json').volunteer);
      return c.json({ ok: true });
    },
  );

  // Customer adds details (email, phone, notes) to an order not sent yet: they
  // never replace what it had, and the organiser is told.
  app.post(
    '/:id/details',
    zValidator('param', idParam),
    zValidator('json', addOrderDetailsRequest),
    async (c) => {
      const { sub } = c.get('claims');
      const db = c.get('db');
      const order = await addOrderDetails(db, c.get('shop'), c.req.valid('param').id, sub, c.req.valid('json').encrypted);
      const customer = await describeCustomer(db, sub);
      await notifyShopTeam(db, c.get('env'), c.get('shop'), (lang) => buildDetailsAddedMessage(lang, order, customer));
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
