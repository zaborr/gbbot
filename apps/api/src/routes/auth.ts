import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authRequest, webAuthRequest, type AuthResponse } from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { validateInitData } from '../auth/init-data.js';
import { signSession } from '../auth/jwt.js';
import { claimInvites } from '../services/testingAdd.js';
import { claimPendingOrders } from '../services/adminOrders.js';
import { getUser, upsertUser } from '../services/users.js';
import { signInWithKey } from '../services/webKeys.js';
import { shops } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { claimPendingRoles } from '../services/team.js';
import { claimBlacklisted } from '../services/blacklist.js';
import { toSessionUserDTO } from '../db/mappers.js';
import { ApiError } from '../lib/errors.js';
import { signInWebAdmin, webSessionId } from '../services/webAdmins.js';
import { botToken } from '../services/activeBot.js';

export function authRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/', zValidator('json', authRequest), async (c) => {
    const { initData } = c.req.valid('json');
    const env = c.get('env');
    const db = c.get('db');

    const result = validateInitData(initData, botToken(env), {
      maxAgeSeconds: env.INITDATA_MAX_AGE_SECONDS,
    });
    if (!result.ok) {
      throw ApiError.unauthorized(`initData validation failed (${result.error.code})`);
    }
    if (!result.data.user) {
      throw ApiError.unauthorized('initData does not contain a user');
    }

    const userRow = await upsertUser(db, result.data.user);
    // Added by @username to a GB's admins or to the organisers: the role is theirs now.
    await claimPendingRoles(db, userRow.telegramId, userRow.username);
    await claimBlacklisted(db, userRow.telegramId, userRow.username);
    // Orders made for them before they had opened the bot: made now.
    await claimPendingOrders(db, env, userRow.telegramId, userRow.username).catch((error) =>
      console.error('Could not claim pending orders:', error),
    );
    // Put in a testing by hand before they had opened the bot: in now.
    await claimInvites(db, env, userRow.telegramId, userRow.username).catch((error) =>
      console.error('Could not claim testing invites:', error),
    );
    // Platform super-admin status always follows the current ADMIN_TELEGRAM_IDS.
    const role = env.ADMIN_TELEGRAM_IDS.includes(userRow.telegramId) ? 'admin' : 'customer';
    const { token, expiresAt } = await signSession(
      { sub: userRow.telegramId, role },
      env.JWT_SECRET,
      env.JWT_TTL_SECONDS,
    );

    const response: AuthResponse = {
      token,
      expiresAt: expiresAt.toISOString(),
      user: toSessionUserDTO(userRow, role),
    };
    return c.json(response);
  });

  // A customer on the web with the key an organiser gave them: their own account, in that GB.
  app.post('/key', zValidator('json', z.object({ key: z.string().trim().min(8).max(100) })), async (c) => {
    const env = c.get('env');
    const db = c.get('db');
    const found = await signInWithKey(db, c.req.valid('json').key);
    const userRow = found ? await getUser(db, found.userId) : undefined;
    const shop = found ? await db.query.shops.findFirst({ where: eq(shops.id, found.shopId) }) : undefined;
    if (!found || !userRow || !shop) throw ApiError.unauthorized('This key is not valid (wrong, taken back or expired)');
    const ttl = Math.max(60, Math.floor((found.expiresAt.getTime() - Date.now()) / 1000));
    const { token, expiresAt } = await signSession(
      { sub: userRow.telegramId, role: 'customer', ck: found.keyId, ws: shop.id },
      env.JWT_SECRET,
      ttl,
    );
    const response: AuthResponse = {
      token,
      expiresAt: expiresAt.toISOString(),
      user: toSessionUserDTO(userRow, 'customer'),
      webShop: { id: shop.id, slug: shop.slug },
    };
    return c.json(response);
  });

  // Web accounts (platform admins, or managers linked to their Telegram user):
  // only through the .onion address unless WEB_LOGIN_ONION_ONLY=false.
  app.post('/web', zValidator('json', webAuthRequest), async (c) => {
    const env = c.get('env');
    const host = new URL(c.req.url).hostname;
    if (env.WEB_LOGIN_ONION_ONLY !== false && !host.endsWith('.onion')) {
      throw new ApiError(403, 'onion_only', 'Web sign-in is only available through the Tor address');
    }
    const { username, password, code } = c.req.valid('json');
    const db = c.get('db');
    const account = await signInWebAdmin(db, username, password, code);
    const ttl = env.WEB_SESSION_TTL_SECONDS ?? 8 * 3600;

    // A linked account acts as its Telegram user, with that user's permissions.
    if (account.role === 'linked') {
      const userRow =
        account.telegramId === null ? undefined : await getUser(db, account.telegramId);
      if (!userRow) throw ApiError.unauthorized('Wrong username, password or code');
      const role = env.ADMIN_TELEGRAM_IDS.includes(userRow.telegramId) ? 'admin' : 'customer';
      const { token, expiresAt } = await signSession(
        { sub: userRow.telegramId, role, ver: account.sessionVersion, wid: account.id },
        env.JWT_SECRET,
        ttl,
      );
      const response: AuthResponse = {
        token,
        expiresAt: expiresAt.toISOString(),
        user: toSessionUserDTO(userRow, role),
        webRole: account.role,
      };
      return c.json(response);
    }

    const { token, expiresAt } = await signSession(
      {
        sub: webSessionId(account.id),
        role: 'admin',
        ver: account.sessionVersion,
        wid: account.id,
      },
      env.JWT_SECRET,
      ttl,
    );
    const response: AuthResponse = {
      token,
      expiresAt: expiresAt.toISOString(),
      user: {
        telegramId: webSessionId(account.id),
        firstName: account.username,
        username: account.username,
        languageCode: null,
        role: 'admin',
        language: 'es',
        preferredLanguage: null,
      },
      webRole: account.role,
    };
    return c.json(response);
  });

  return app;
}
