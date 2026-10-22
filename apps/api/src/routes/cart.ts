import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { addToCartRequest, updateCartItemRequest } from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { requireAuth, requireTelegramUser } from '../auth/middleware.js';
import { addItem, getCart, setItemQuantity } from '../services/cart.js';
import { assertOpen } from '../services/closing.js';

/** A cart line id (older clients send a product id, also accepted). */
const lineParam = z.object({ lineId: z.uuid() });

export function cartRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireTelegramUser);

  app.get('/', async (c) => {
    const { sub } = c.get('claims');
    return c.json(await getCart(c.get('db'), c.get('shopId'), sub, c.get('isVip')));
  });

  app.post('/items', zValidator('json', addToCartRequest), async (c) => {
    const { sub } = c.get('claims');
    const { productId, variantId, quantity } = c.req.valid('json');
    assertOpen(c.get('shop'));
    return c.json(
      await addItem(
        c.get('db'),
        c.get('shopId'),
        sub,
        productId,
        variantId,
        quantity,
        c.get('isVip'),
      ),
    );
  });

  app.patch(
    '/items/:lineId',
    zValidator('param', lineParam),
    zValidator('json', updateCartItemRequest),
    async (c) => {
      const { sub } = c.get('claims');
      const { lineId } = c.req.valid('param');
      const { quantity } = c.req.valid('json');
      if (quantity > 0) assertOpen(c.get('shop'));
      return c.json(
        await setItemQuantity(c.get('db'), c.get('shopId'), sub, lineId, quantity, c.get('isVip')),
      );
    },
  );

  app.delete('/items/:lineId', zValidator('param', lineParam), async (c) => {
    const { sub } = c.get('claims');
    const { lineId } = c.req.valid('param');
    return c.json(
      await setItemQuantity(c.get('db'), c.get('shopId'), sub, lineId, 0, c.get('isVip')),
    );
  });

  return app;
}
