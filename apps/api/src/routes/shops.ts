import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { carts, orders, users } from '../db/schema.js';
import type { AppBindings } from '../context.js';
import type { Database } from '../db/client.js';
import { requireAuth } from '../auth/middleware.js';
import { isSuperAdmin, listShops } from '../services/shop.js';
import { isWebSession } from '../services/webAdmins.js';
import { isOrganizer, managesSomething } from '../services/team.js';

/** `GET /api/shops`: the start screen — visible shops plus hidden ones the user manages. */
export function shopsRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    const { sub } = c.get('claims');
    const env = c.get('env');
    const db = c.get('db');
    const shops = await listShops(db, env, sub);
    const manages = await managesSomething(db, env, sub);
    return c.json({
      shops,
      isSuperAdmin: isSuperAdmin(env, sub),
      isOrganizer: await isOrganizer(db, sub),
      // Managers may activate web access (Telegram sessions only).
      canUseWeb: !isWebSession(c.get('claims')) && manages,
      // "How it works": once per person, and never to customers or the team.
      showHowTo: !isWebSession(c.get('claims')) && !manages && (await isNewcomer(db, sub)),
    });
  });

  return app;
}

/** Has not closed "how it works" yet, and has never ordered nor filled a cart. */
async function isNewcomer(db: Database, userId: number): Promise<boolean> {
  const [user, order, cart] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.telegramId, userId), columns: { howToSeen: true } }),
    db.query.orders.findFirst({ where: eq(orders.userId, userId), columns: { id: true } }),
    db.query.carts.findFirst({ where: eq(carts.userId, userId), columns: { id: true } }),
  ]);
  return user !== undefined && !user.howToSeen && order === undefined && cart === undefined;
}
