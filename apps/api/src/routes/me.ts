import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  accountPassword,
  changePasswordRequest,
  inviteCode,
  createAccountRequest,
  createWebAccessRequest,
  telegramProof,
  securityPhraseRequest,
  updateLanguageRequest,
  type WebAccessStatus,
  type WebCredentials,
} from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import type { Database } from '../db/client.js';
import type { Env } from '../config/env.js';
import { requireAuth, requireTelegramUser } from '../auth/middleware.js';
import { setPreferredLanguage } from '../services/users.js';
import { noticesOf } from '../services/webKeys.js';
import { toSessionUserDTO } from '../db/mappers.js';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { open, seal, secretKey } from '../lib/secretBox.js';
import { tr, type BotMessageKey } from '../i18n/messages.js';
import { describeUser, managesSomething } from '../services/team.js';
import { notifyPlatform } from '../services/webNotices.js';
import {
  createWebAdmin,
  removeWebAdmin,
  resetWebAdmin,
  webAccountOf,
} from '../services/webAdmins.js';
import { customerOnly } from '../auth/jwt.js';
import {
  accountSession,
  confirmLink,
  confirmManaging,
  createOwnAccount,
  setPassword,
  signUp,
  startManaging,
} from '../services/accounts.js';
import { accountOf } from '../services/webAdmins.js';
import { webKeys } from '../db/schema.js';
import { z } from 'zod';

/** The signed-in user's own settings. */
export function meRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth, requireTelegramUser);

  // --- Their customer web account (username and password) ---------------------

  app.get('/account', async (c) => {
    const db = c.get('db');
    const sub = c.get('claims').sub;
    const row = await accountOf(db, sub);
    return c.json({
      account: row ? { username: row.username, linkState: row.linkState, manages: row.totpSecret !== null } : null,
      // Manages GBs: their account may add the authenticator to manage on the web too.
      managesSomething: await managesSomething(db, c.get('env'), sub),
    });
  });

  // Managing on the web with this same account: Telegram proves it is them,
  // then the first code from the authenticator app turns it on.
  app.post('/account/manage/start', zValidator('json', z.object({ telegram: telegramProof })), async (c) =>
    c.json(await startManaging(c.get('db'), c.get('env'), c.get('claims').sub, c.req.valid('json').telegram)),
  );
  app.post('/account/manage/confirm', zValidator('json', z.object({ code: z.string().trim().min(6).max(8) })), async (c) => {
    await confirmManaging(c.get('db'), c.get('claims').sub, c.req.valid('json').code);
    return c.json({ manages: true });
  });

  // From the Mini App (Telegram says who they are) or a web key (the ID the
  // staff gave, unless the login bot confirms it).
  app.post('/account', zValidator('json', createAccountRequest), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const claims = c.get('claims');
    if (claims.cs) throw ApiError.conflict('has_account', 'You already have a web account: sign in');
    const key = claims.ck ? await db.query.webKeys.findFirst({ where: eq(webKeys.id, claims.ck) }) : undefined;
    const row = await createOwnAccount(db, {
      telegramId: claims.sub,
      fromTelegram: claims.ck === undefined,
      keyGivenBy: key?.createdBy ?? null,
      ...c.req.valid('json'),
    });
    const { token, expiresAt } = await accountSession(env, row);
    return c.json({ username: row.username, linkState: row.linkState, token, expiresAt: expiresAt.toISOString() }, 201);
  });

  // In Telegram, at the entrance (private mode): an invitation, and their web
  // account at once (Telegram already says who they are: confirmed).
  app.post(
    '/join',
    zValidator('json', z.object({ code: inviteCode, username: z.string().trim().min(3).max(32), password: accountPassword })),
    async (c) => {
      const db = c.get('db');
      const claims = c.get('claims');
      if (claims.wid !== undefined || claims.ck !== undefined) {
        throw ApiError.forbidden('Only available in Telegram');
      }
      const me = await db.query.users.findFirst({ where: eq(users.telegramId, claims.sub) });
      const row = await signUp(db, {
        ...c.req.valid('json'),
        trusted: { id: claims.sub, firstName: me?.firstName ?? String(claims.sub), username: me?.username ?? null },
      });
      return c.json({ username: row.username, linkState: row.linkState }, 201);
    },
  );

  // A new password: with the current one, or proving their Telegram. Other
  // sessions end; a web account session gets a fresh token.
  app.put('/account/password', zValidator('json', changePasswordRequest), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const claims = c.get('claims');
    const row = await setPassword(db, {
      telegramId: claims.sub,
      ...c.req.valid('json'),
      telegramSession: claims.wid === undefined && claims.ck === undefined,
    });
    const { token, expiresAt } = await accountSession(env, row);
    return c.json({ token, expiresAt: expiresAt.toISOString() });
  });

  // The staff tied it to an ID: their Telegram (the login bot) confirms it.
  app.post('/account/confirm', zValidator('json', z.object({ telegram: telegramProof })), async (c) => {
    const claims = c.get('claims');
    const row = await accountOf(c.get('db'), claims.sub);
    if (!row) throw ApiError.notFound('You have no web account');
    await confirmLink(c.get('db'), row.id, c.req.valid('json').telegram);
    return c.json({ linkState: 'confirmed' });
  });

  // Language chosen in the app (null = follow Telegram); also used by the bot.
  app.put('/language', zValidator('json', updateLanguageRequest), async (c) => {
    const { sub, role } = c.get('claims');
    const row = await setPreferredLanguage(c.get('db'), sub, c.req.valid('json').language);
    return c.json(toSessionUserDTO(row, role));
  });

  // Security phrase: only its owner reads it (shown in the app and when paying).
  app.get('/security-phrase', async (c) => {
    const row = await c.get('db').query.users.findFirst({ where: eq(users.telegramId, c.get('claims').sub) });
    const phrase = row?.securityPhrase ? open(secretKey(c.get('env')), row.securityPhrase) : null;
    return c.json({ phrase });
  });
  app.put('/security-phrase', zValidator('json', securityPhraseRequest), async (c) => {
    const { phrase } = c.req.valid('json');
    // With a web key: chosen if they have none (to order), never changed — whoever
    // gave the key must not replace it with one of their own.
    if (c.get('claims').ck !== undefined) {
      const row = await c.get('db').query.users.findFirst({ where: eq(users.telegramId, c.get('claims').sub) });
      if (row?.securityPhrase) throw ApiError.forbidden('Change your security phrase in Telegram');
    }
    await c
      .get('db')
      .update(users)
      .set({ securityPhrase: seal(secretKey(c.get('env')), phrase) })
      .where(eq(users.telegramId, c.get('claims').sub));
    return c.json({ phrase });
  });

  // Closed "how it works": not shown again on any device.
  app.post('/how-to-seen', async (c) => {
    await c
      .get('db')
      .update(users)
      .set({ howToSeen: true })
      .where(eq(users.telegramId, c.get('claims').sub));
    return c.json({ ok: true });
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
      onionUrl: webPanelUrl(env),
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
    const result: WebCredentials = { ...creds, onionUrl: webPanelUrl(env) };
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
    const result: WebCredentials = { ...creds, onionUrl: webPanelUrl(env) };
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

  // A customer on the web: what the bot told them (also while the bot is down).
  app.get('/notices', requireAuth, async (c) => {
    const claims = c.get('claims');
    const { sub, ck } = claims;
    // Someone who manages GBs, signed in with a key (to buy): what the bot tells
    // them includes their GBs' business, which whoever gave the key must not read.
    // Their inbox is in their web account.
    if (customerOnly(claims) && (await managesSomething(c.get('db'), c.get('env'), sub))) return c.json([]);
    return c.json(await noticesOf(c.get('db'), sub, ck));
  });

  return app;
}

/**
 * Where the web panel opens: the main domain's /admin, or the .onion address
 * when web sign-in is only allowed there (WEB_LOGIN_ONION_ONLY).
 */
function webPanelUrl(env: Env): string | null {
  if (env.WEB_LOGIN_ONION_ONLY === true) return env.WEB_ONION_URL ?? null;
  return env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, '')}/admin` : (env.WEB_ONION_URL ?? null);
}
