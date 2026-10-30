import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  addToBlacklistRequest,
  blacklistWho,
  langFrom,
  platformShopInput,
  retentionSettings,
  updateOrganizersRequest,
  updateVipClubRequest,
} from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import type { Database } from '../db/client.js';
import type { Env } from '../config/env.js';
import { requireAuth, requireFullPlatform, requireSuperAdmin } from '../auth/middleware.js';
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
import { getPlatformClub, getPlatformVipClub, updatePlatformClub, updatePlatformVipClub } from '../services/vip.js';
import { getOrganizers, getShopTeam, updateOrganizers } from '../services/team.js';
import { ApiError } from '../lib/errors.js';
import { shops } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { SessionClaims } from '../auth/jwt.js';
import {
  deleteWebNotices,
  listWebNotices,
  markWebNoticesSeen,
  notifyPlatform,
  unreadWebNotices,
} from '../services/webNotices.js';
import { describeWebAdmin, webAccountId } from '../services/webAdmins.js';
import {
  addToPlatformBlacklist,
  checkBlacklist,
  platformBlacklistView,
  removeFromPlatformBlacklist,
} from '../services/blacklist.js';
import { tr } from '../i18n/messages.js';

const idParam = z.object({ id: z.uuid() });

/** Platform super-admin: every shop, including hidden ones; create, edit, delete. */
export function platformRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireSuperAdmin);

  app.get('/shops', async (c) => c.json(await listAllShops(c.get('db'))));

  // Platform blacklist: for those in it no GB exists.
  app.get('/blacklist', async (c) => c.json(await platformBlacklistView(c.get('db'))));
  app.post('/blacklist/check', zValidator('json', blacklistWho), async (c) =>
    c.json(await checkBlacklist(c.get('db'), c.req.valid('json').who, null)),
  );
  app.post('/blacklist', zValidator('json', addToBlacklistRequest), async (c) => {
    const { who, removeData } = c.req.valid('json');
    return c.json(await addToPlatformBlacklist(c.get('db'), c.get('env'), who, removeData));
  });
  app.post('/blacklist/remove', zValidator('json', blacklistWho), async (c) =>
    c.json(await removeFromPlatformBlacklist(c.get('db'), c.req.valid('json').who)),
  );

  // Inbox of the web administrators (in Telegram the bot sends these messages).
  const webAdminId = (claims: SessionClaims): number => {
    const id = webAccountId(claims);
    if (id === undefined) throw ApiError.forbidden('Only for web administrators');
    return id;
  };
  app.get('/notices', async (c) =>
    c.json(
      await listWebNotices(
        c.get('db'),
        webAdminId(c.get('claims')),
        langFrom(c.req.header('X-Lang')),
      ),
    ),
  );
  app.get('/notices/unread', async (c) =>
    c.json({ unread: await unreadWebNotices(c.get('db'), webAdminId(c.get('claims'))) }),
  );
  app.post(
    '/notices/seen',
    zValidator('json', z.object({ upTo: z.number().int().nonnegative() })),
    async (c) => {
      const adminId = webAdminId(c.get('claims'));
      await markWebNoticesSeen(c.get('db'), adminId, c.req.valid('json').upTo);
      return c.body(null, 204);
    },
  );
  // Full platform accounts clear the shared inbox; each deletion leaves a notice.
  const deleted = async (db: Database, env: Env, sub: number, count: number): Promise<void> => {
    if (count === 0) return;
    const who = await describeWebAdmin(db, sub);
    await notifyPlatform(db, env, (lang) =>
      tr(lang, count === 1 ? 'web.noticeDeleted' : 'web.noticesDeleted', { who, count }),
    );
  };
  app.delete('/notices', requireFullPlatform, async (c) => {
    const db = c.get('db');
    await deleted(db, c.get('env'), c.get('claims').sub, await deleteWebNotices(db));
    return c.body(null, 204);
  });
  app.delete(
    '/notices/:id',
    requireFullPlatform,
    zValidator('param', z.object({ id: z.coerce.number().int().positive() })),
    async (c) => {
      const db = c.get('db');
      const count = await deleteWebNotices(db, c.req.valid('param').id);
      await deleted(db, c.get('env'), c.get('claims').sub, count);
      return c.body(null, 204);
    },
  );

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

  // The platform-wide guests (shops can count them as their guests).
  app.get('/guests', async (c) => c.json(await getPlatformClub(c.get('db'), 'guest')));
  app.put('/guests', zValidator('json', updateVipClubRequest), async (c) =>
    c.json(await updatePlatformClub(c.get('db'), c.get('env'), c.req.valid('json'), 'guest')),
  );

  return app;
}
