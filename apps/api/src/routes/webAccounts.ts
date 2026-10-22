import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createMiddleware } from 'hono/factory';
import {
  changeWebPasswordRequest,
  createWebAccountRequest,
  setWebRoleRequest,
  type Lang,
  type WebAccountView,
  type WebCredentials,
  type WebRole,
} from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import type { Database } from '../db/client.js';
import type { Env } from '../config/env.js';
import { requireAuth } from '../auth/middleware.js';
import { signSession } from '../auth/jwt.js';
import { ApiError } from '../lib/errors.js';
import { tr, type BotMessageKey } from '../i18n/messages.js';
import { loadPeople } from '../services/team.js';
import { notifyPlatform } from '../services/webNotices.js';
import {
  assertNotLastFullAdmin,
  changeWebPassword,
  createWebAdmin,
  describeWebAdmin,
  getWebAdmin,
  isWebAdminId,
  listWebAdmins,
  removeWebAdmin,
  resetWebAdmin,
  setWebAdminRole,
  webAccountId,
  type WebAdminRow,
} from '../services/webAdmins.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const roleName = (lang: Lang, role: WebRole): string =>
  tr(lang, `web.role.${role}` as BotMessageKey);

/**
 * Web accounts. Any web session may change its own password; the panel of
 * accounts is for full platform accounts only.
 */
export function webAccountRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth);

  // The signed-in web account's own password; the caller gets a fresh session
  // (every other session of the account ends).
  app.post('/me/password', zValidator('json', changeWebPasswordRequest), async (c) => {
    const env = c.get('env');
    const claims = c.get('claims');
    const id = webAccountId(claims);
    if (id === undefined) throw ApiError.forbidden('Only for web administrators');
    const { current, next } = c.req.valid('json');
    const ver = await changeWebPassword(c.get('db'), id, current, next);
    const session = await signSession(
      { ...claims, ver, wid: id },
      env.JWT_SECRET,
      env.WEB_SESSION_TTL_SECONDS,
    );
    return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString() });
  });

  // The panel of accounts: full platform accounts only.
  const requireFullPlatform = createMiddleware<AppBindings>(async (c, next) => {
    const claims = c.get('claims');
    const id = webAccountId(claims);
    const platform = id !== undefined && isWebAdminId(claims.sub);
    const row = platform ? await getWebAdmin(c.get('db'), id) : undefined;
    if (row?.role !== 'platform') {
      throw ApiError.forbidden('Only for full platform accounts');
    }
    await next();
  });

  const tellPlatform = async (
    db: Database,
    env: Env,
    actorSub: number,
    key: Extract<
      BotMessageKey,
      'web.accountCreated' | 'web.accountReset' | 'web.accountRemoved' | 'web.accountRole'
    >,
    row: Pick<WebAdminRow, 'username'>,
    role?: WebRole,
  ): Promise<void> => {
    const who = await describeWebAdmin(db, actorSub);
    await notifyPlatform(db, env, (lang) =>
      tr(lang, key, { who, username: row.username, role: role ? roleName(lang, role) : '' }),
    );
  };

  const load = async (db: Database, id: number): Promise<WebAdminRow> => {
    const row = await getWebAdmin(db, id);
    if (!row) throw ApiError.notFound('There is no such web account');
    return row;
  };

  app.get('/', requireFullPlatform, async (c) => {
    const db = c.get('db');
    const me = webAccountId(c.get('claims'));
    const rows = await listWebAdmins(db);
    const people = await loadPeople(
      db,
      rows.flatMap((r) => (r.telegramId === null ? [] : [r.telegramId])),
    );
    const now = new Date();
    const view: WebAccountView[] = rows.map((r) => {
      const person = r.telegramId === null ? undefined : people.get(r.telegramId);
      return {
        id: r.id,
        username: r.username,
        role: r.role,
        telegram:
          r.telegramId === null
            ? null
            : {
                id: r.telegramId,
                name: person?.username
                  ? `@${person.username}`
                  : (person?.firstName ?? String(r.telegramId)),
              },
        lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
        locked: r.lockedUntil !== null && r.lockedUntil > now,
        createdAt: r.createdAt.toISOString(),
        isMe: r.id === me,
      };
    });
    return c.json(view);
  });

  app.post('/', requireFullPlatform, zValidator('json', createWebAccountRequest), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const { username, role } = c.req.valid('json');
    const creds = await createWebAdmin(db, username, { role });
    await tellPlatform(db, env, c.get('claims').sub, 'web.accountCreated', creds, role);
    const result: WebCredentials = { ...creds, onionUrl: env.WEB_ONION_URL ?? null };
    return c.json(result, 201);
  });

  // New password and code; its sessions end.
  app.post('/:id/reset', requireFullPlatform, zValidator('param', idParam), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const row = await load(db, c.req.valid('param').id);
    const creds = await resetWebAdmin(db, row.username);
    await tellPlatform(db, env, c.get('claims').sub, 'web.accountReset', row);
    const result: WebCredentials = { ...creds, onionUrl: env.WEB_ONION_URL ?? null };
    return c.json(result);
  });

  app.put(
    '/:id/role',
    requireFullPlatform,
    zValidator('param', idParam),
    zValidator('json', setWebRoleRequest),
    async (c) => {
      const db = c.get('db');
      const row = await load(db, c.req.valid('param').id);
      const { role } = c.req.valid('json');
      if (role !== row.role) {
        await setWebAdminRole(db, row, role);
        await tellPlatform(db, c.get('env'), c.get('claims').sub, 'web.accountRole', row, role);
      }
      return c.body(null, 204);
    },
  );

  // Only the web account: a linked one keeps its permissions in Telegram.
  app.delete('/:id', requireFullPlatform, zValidator('param', idParam), async (c) => {
    const db = c.get('db');
    const row = await load(db, c.req.valid('param').id);
    await assertNotLastFullAdmin(db, row);
    await removeWebAdmin(db, row.username);
    await tellPlatform(db, c.get('env'), c.get('claims').sub, 'web.accountRemoved', row);
    return c.body(null, 204);
  });

  return app;
}
