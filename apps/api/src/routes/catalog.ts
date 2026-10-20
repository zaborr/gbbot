import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { acceptDisclaimerRequest, catalogQuery } from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { getProductById, listCategories, listProducts } from '../services/catalog.js';
import { getShopConfig, teamIds } from '../services/shop.js';
import { loadGoalProgress } from '../services/goal.js';
import { loadPeople, organizerTags } from '../services/team.js';
import { acceptDisclaimer } from '../services/disclaimer.js';
import { requireAuth } from '../auth/middleware.js';
import { ApiError } from '../lib/errors.js';

const idParam = z.object({ id: z.uuid() });

export function catalogRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/shop', async (c) => {
    const shop = c.get('shop');
    const [people, goal] = await Promise.all([
      loadPeople(c.get('db'), teamIds(shop)),
      loadGoalProgress(c.get('db'), shop, c.get('canManage')),
    ]);
    return c.json(
      getShopConfig(shop, c.get('canManage'), c.get('isVip'), {
        canOwn: c.get('canOwn'),
        organizers: organizerTags(shop, people),
        disclaimerAccepted: !c.get('disclaimerPending'),
        goal,
      }),
    );
  });

  // The customer accepts the GB's conditions (the version they read).
  app.post('/shop/disclaimer/accept', requireAuth, zValidator('json', acceptDisclaimerRequest), async (c) => {
    await acceptDisclaimer(c.get('db'), c.get('shop'), c.get('claims').sub, c.req.valid('json').version);
    return c.body(null, 204);
  });

  app.get('/categories', async (c) => c.json(await listCategories(c.get('db'), c.get('shopId'))));

  app.get('/products', zValidator('query', catalogQuery), async (c) => {
    // VIP prices only reach the GB's VIPs and its admins.
    const page = await listProducts(
      c.get('db'),
      c.get('shopId'),
      c.req.valid('query'),
      c.get('isVip') || c.get('canManage'),
    );
    return c.json(page);
  });

  app.get('/products/:id', zValidator('param', idParam), async (c) => {
    const product = await getProductById(
      c.get('db'),
      c.get('shopId'),
      c.req.valid('param').id,
      c.get('canManage'),
      c.get('isVip') || c.get('canManage'),
    );
    if (!product) throw ApiError.notFound('Product not found');
    return c.json(product);
  });

  return app;
}
