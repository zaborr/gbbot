import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  createWebAccessRequest,
  updateLanguageRequest,
  type WebAccessStatus,
  type WebCredentials,
} from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import type { Database } from '../db/client.js';
import type { Env } from '../config/env.js';
import { requireAuth, requireTelegramUser } from '../auth/middleware.js';
import { setPreferredLanguage } from '../services/users.js';
import { toSessionUserDTO } from '../db/mappers.js';
import { ApiError } from '../lib/errors.js';
import { tr, type BotMessageKey } from '../i18n/messages.js';
import { describeUser, managesSomething } from '../services/team.js';
import { notifyPlatform } from '../services/webNotices.js';
import {
  createWebAdmin,
  removeWebAdmin,
  resetWebAdmin,
  webAccountOf,
} from '../services/webAdmins.js';

/** The signed-in user's own settings. */
export function meRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireTelegramUser);

  // Language chosen in the app (null = follow Telegram); also used by the bot.
  app.put('/language', zValidator('json', updateLanguageRequest), async (c) => {
    const { sub, role } = c.get('claims');
    const row = await setPreferredLanguage(c.get('db'), sub, c.req.valid('json').language);
    return c.json(toSessionUserDTO(row, role));
  });

  /*
   * Web access (the panel through Tor) for whoever manages something: they
   * activate it here, so their Telegram account proves who they are. The
   * account acts as this Telegram user, with the same permissions.
   */
  const assertManager = async (db: Database, env: Env, sub: number): Promise<void> => {
    if (!(await managesSomething(db, env, sub))) {
      throw ApiError.forbidden('Only for people who manage a GB');
    }
  };
  const tellPlatform = async (
    db: Database,
    env: Env,
    sub: number,
    key: Extract<BotMessageKey, 'web.activated' | 'web.renewed' | 'web.deactivated'>,
    username: string,
  ): Promise<void> => {
    const who = await describeUser(db, sub);
    await notifyPlatform(db, env, (lang) => tr(lang, key, { who, username }));
  };

  app.get('/web-access', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const { sub } = c.get('claims');
    await assertManager(db, env, sub);
    const account = await webAccountOf(db, sub);
    const status: WebAccessStatus = {
      account: account
        ? { username: account.username, lastLoginAt: account.lastLoginAt?.toISOString() ?? null }
        : null,
      onionUrl: env.WEB_ONION_URL ?? null,
    };
    return c.json(status);
  });

  app.post('/web-access', zValidator('json', createWebAccessRequest), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const { sub } = c.get('claims');
    await assertManager(db, env, sub);
    if (await webAccountOf(db, sub)) {
      throw ApiError.conflict('web_access_exists', 'You already have web access');
    }
    const creds = await createWebAdmin(db, c.req.valid('json').username, {
      role: 'linked',
      telegramId: sub,
    });
    await tellPlatform(db, env, sub, 'web.activated', creds.username);
    const result: WebCredentials = { ...creds, onionUrl: env.WEB_ONION_URL ?? null };
    return c.json(result, 201);
  });

  // New password and code (lost phone, forgotten password); open sessions end.
  app.post('/web-access/reset', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const { sub } = c.get('claims');
    await assertManager(db, env, sub);
    const account = await webAccountOf(db, sub);
    if (!account) throw ApiError.notFound('You have no web access');
    const creds = await resetWebAdmin(db, account.username);
    await tellPlatform(db, env, sub, 'web.renewed', creds.username);
    const result: WebCredentials = { ...creds, onionUrl: env.WEB_ONION_URL ?? null };
    return c.json(result);
  });

  app.delete('/web-access', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const { sub } = c.get('claims');
    const account = await webAccountOf(db, sub);
    if (account) {
      await removeWebAdmin(db, account.username);
      await tellPlatform(db, env, sub, 'web.deactivated', account.username);
    }
    return c.body(null, 204);
  });

  return app;
}
