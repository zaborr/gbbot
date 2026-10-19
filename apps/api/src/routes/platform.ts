import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  platformShopInput,
  retentionSettings,
  updateOrganizersRequest,
  updateVipClubRequest,
} from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { requireAuth, requireSuperAdmin } from '../auth/middleware.js';
import {
  createShop,
  deleteShop,
  deleteShopWithEverything,
  listAllShops,
  shopContents,
  updatePlatformShop,
  moveShop,
} from '../services/shop.js';
import { getRetention, runRetention, updateRetention } from '../services/retention.js';
import { getPlatformVipClub, updatePlatformVipClub } from '../services/vip.js';
import { getOrganizers, getShopTeam, updateOrganizers } from '../services/team.js';
import { ApiError } from '../lib/errors.js';
import { shops } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const idParam = z.object({ id: z.uuid() });

/** Platform super-admin: every shop, including hidden ones; create, edit, delete. */
export function platformRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireSuperAdmin);

  app.get('/shops', async (c) => c.json(await listAllShops(c.get('db'))));

  app.post('/shops', zValidator('json', platformShopInput), async (c) =>
    c.json(await createShop(c.get('db'), c.req.valid('json')), 201),
  );

  app.put(
    '/shops/:id',
    zValidator('param', idParam),
    zValidator('json', platformShopInput),
    async (c) =>
      c.json(await updatePlatformShop(c.get('db'), c.req.valid('param').id, c.req.valid('json'))),
  );

  app.delete('/shops/:id', zValidator('param', idParam), async (c) => {
    await deleteShop(c.get('db'), c.req.valid('param').id);
    return c.body(null, 204);
  });

  // Order on the start screen: one place up or down.
  app.post(
    '/shops/:id/move',
    zValidator('param', idParam),
    zValidator('json', z.object({ direction: z.enum(['up', 'down']) })),
    async (c) =>
      c.json(await moveShop(c.get('db'), c.req.valid('param').id, c.req.valid('json').direction)),
  );

  // Who runs a GB, with names (owner, admins, @usernames still to come).
  app.get('/shops/:id/team', zValidator('param', idParam), async (c) => {
    const shop = await c
      .get('db')
      .query.shops.findFirst({ where: eq(shops.id, c.req.valid('param').id) });
    if (!shop) throw ApiError.notFound('Shop not found');
    return c.json(await getShopTeam(c.get('db'), shop));
  });

  // Organisers: may create GBs and run the ones they own.
  app.get('/organizers', async (c) => c.json(await getOrganizers(c.get('db'))));
  app.put('/organizers', zValidator('json', updateOrganizersRequest), async (c) => {
    const { people, releaseShops } = c.req.valid('json');
    return c.json(await updateOrganizers(c.get('db'), people, releaseShops ?? false));
  });

  // Deleting a shop with its orders: first see what goes, then confirm by name.
  app.get('/shops/:id/contents', zValidator('param', idParam), async (c) =>
    c.json(await shopContents(c.get('db'), c.req.valid('param').id)),
  );
  app.post(
    '/shops/:id/delete-all',
    zValidator('param', idParam),
    zValidator('json', z.object({ confirmName: z.string().min(1).max(128) })),
    async (c) =>
      c.json(
        await deleteShopWithEverything(
          c.get('db'),
          c.req.valid('param').id,
          c.req.valid('json').confirmName,
        ),
      ),
  );

  // Data retention: how long personal data is kept, and a manual cleanup.
  app.get('/retention', async (c) => c.json(await getRetention(c.get('db'))));
  app.put('/retention', zValidator('json', retentionSettings), async (c) =>
    c.json(await updateRetention(c.get('db'), c.req.valid('json'))),
  );
  app.post('/retention/run', async (c) => c.json(await runRetention(c.get('db'))));

  // The platform-wide VIP club (shops can count its members as their VIPs).
  app.get('/vip-club', async (c) => c.json(await getPlatformVipClub(c.get('db'))));
  app.put('/vip-club', zValidator('json', updateVipClubRequest), async (c) =>
    c.json(await updatePlatformVipClub(c.get('db'), c.get('env'), c.req.valid('json'))),
  );

  return app;
}
