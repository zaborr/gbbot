import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authRequest, type AuthResponse } from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { validateInitData } from '../auth/init-data.js';
import { signSession } from '../auth/jwt.js';
import { upsertUser } from '../services/users.js';
import { claimPendingRoles } from '../services/team.js';
import { toSessionUserDTO } from '../db/mappers.js';
import { ApiError } from '../lib/errors.js';

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

  return app;
}
