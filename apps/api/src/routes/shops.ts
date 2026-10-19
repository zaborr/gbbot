import { Hono } from 'hono';
import type { AppBindings } from '../context.js';
import { requireAuth } from '../auth/middleware.js';
import { isSuperAdmin, listShops } from '../services/shop.js';
import { isOrganizer } from '../services/team.js';

/** `GET /api/shops`: the start screen — visible shops plus hidden ones the user manages. */
export function shopsRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    const { sub } = c.get('claims');
    const env = c.get('env');
    const db = c.get('db');
    return c.json({
      shops: await listShops(db, env, sub),
      isSuperAdmin: isSuperAdmin(env, sub),
      isOrganizer: await isOrganizer(db, sub),
    });
  });

  return app;
}
