import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authRequest, webAuthRequest, type AuthResponse } from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { validateInitData } from '../auth/init-data.js';
import { signSession } from '../auth/jwt.js';
import { getUser, upsertUser } from '../services/users.js';
import { claimPendingRoles } from '../services/team.js';
import { toSessionUserDTO } from '../db/mappers.js';
import { ApiError } from '../lib/errors.js';
import { signInWebAdmin, webSessionId } from '../services/webAdmins.js';

export function authRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/', zValidator('json', authRequest), async (c) => {
    const { initData } = c.req.valid('json');
    const env = c.get('env');
    const db = c.get('db');

    const result = validateInitData(initData, env.BOT_TOKEN, {
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
    };
    return c.json(response);
  });

  return app;
}
