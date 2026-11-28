import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  accountLoginRequest,
  authRequest,
  inviteCode,
  signupRequest,
  accountPassword,
  telegramProof,
  webAuthRequest,
  type AuthResponse,
} from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import type { Env } from '../config/env.js';
import { accountByTelegram, accountSession, claimAccount, inviteInfo, signUp, type AccountRow } from '../services/accounts.js';
import { CALLBACK_PATH, finishTelegramLogin, startTelegramLogin } from '../services/telegramLogin.js';
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
import { clientIp } from '../middleware/rateLimit.js';
import { ApiError } from '../lib/errors.js';
import { signInWebAdmin, signInWithPassword, webSessionId } from '../services/webAdmins.js';
import { botToken } from '../services/activeBot.js';

/**
 * What was waiting for them by @username, now that Telegram says who they are
 * (the Mini App, or the login bot on the web).
 */
async function claimWhatIsTheirs(db: Database, env: Env, telegramId: number, username: string | null): Promise<void> {
  // Added by @username to a GB's admins or to the organisers: the role is theirs now.
  await claimPendingRoles(db, telegramId, username);
  await claimBlacklisted(db, telegramId, username);
  // Orders made for them before they had opened the bot: made now.
  await claimPendingOrders(db, env, telegramId, username).catch((error) =>
    console.error('Could not claim pending orders:', error),
  );
  // Put in a testing by hand before they had opened the bot: in now.
  await claimInvites(db, env, telegramId, username).catch((error) =>
    console.error('Could not claim testing invites:', error),
  );
}

/** The answer to a customer's web account sign-in (any way in). */
async function accountResponse(db: Database, env: Env, row: AccountRow): Promise<AuthResponse> {
  const userRow = await getUser(db, row.telegramId);
  if (!userRow) throw ApiError.unauthorized('Wrong username or password');
  const { token, expiresAt } = await accountSession(env, row);
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    user: toSessionUserDTO(userRow, 'customer'),
    account: { username: row.username, linkState: row.linkState },
  };
}

/** The page Telegram sends people back to, in their browser's language. */
/** The page's own origin (behind Caddy the API sees plain http). */
function pageOrigin(requestUrl: string, forwardedProto: string | undefined): string {
  const url = new URL(requestUrl);
  return `${forwardedProto ?? url.protocol.replace(':', '')}://${url.host}`;
}

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
    await claimWhatIsTheirs(db, env, userRow.telegramId, userRow.username);
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
  // on the main domain and the .onion address; only the .onion address with
  // WEB_LOGIN_ONION_ONLY=true. Never on the customer-only domains (see app.ts).
  app.post('/web', zValidator('json', webAuthRequest), async (c) => {
    const env = c.get('env');
    const host = new URL(c.req.url).hostname;
    if (env.WEB_LOGIN_ONION_ONLY === true && !host.endsWith('.onion')) {
      throw new ApiError(403, 'onion_only', 'Web sign-in is only available through the Tor address');
    }
    const { username, password, code } = c.req.valid('json');
    const db = c.get('db');
    const onion = host.endsWith('.onion');
    const account = await signInWebAdmin(db, username, password, code, {
      from: onion ? 'onion' : clientIp(c),
      // Full platform accounts only through the .onion address, if so configured.
      platformAllowed: onion || env.WEB_PLATFORM_ONION_ONLY !== true,
    });
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

  // --- Customers' web accounts --------------------------------------------------

  // The sign-up page, with a code: a group's invitation, or whose personal one.
  app.post('/invite', zValidator('json', z.object({ code: inviteCode })), async (c) =>
    c.json(await inviteInfo(c.get('db'), c.req.valid('json').code)),
  );

  // Opening a web account with an invitation (group: Telegram by the login bot).
  app.post('/signup', zValidator('json', signupRequest), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const row = await signUp(db, c.req.valid('json'));
    const userRow = await getUser(db, row.telegramId);
    await claimWhatIsTheirs(db, env, row.telegramId, userRow?.username ?? null);
    return c.json(await accountResponse(db, env, row), 201);
  });

  // Username and password: the customer side only.
  app.post('/login', zValidator('json', accountLoginRequest), async (c) => {
    const db = c.get('db');
    const { username, password } = c.req.valid('json');
    const host = new URL(c.req.url).hostname;
    const row = await signInWithPassword(db, username, password, {
      from: host.endsWith('.onion') ? 'onion' : clientIp(c),
    });
    return c.json(await accountResponse(db, c.get('env'), row));
  });

  // "Log in with Telegram" (the login bot), in the same tab: start (the page
  // goes to this address, saying what it is doing), and the way back from
  // Telegram, which sends the browser on to the page with a one-time ticket.
  app.post('/telegram/start', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { context?: unknown };
    const context = typeof body.context === 'string' ? body.context.slice(0, 300) : '';
    return c.json(startTelegramLogin(c.get('env'), pageOrigin(c.req.url, c.req.header('X-Forwarded-Proto')), context));
  });
  app.get(CALLBACK_PATH.replace('/api/auth', ''), async (c) => {
    const back = await finishTelegramLogin(c.get('env'), {
      state: c.req.query('state') ?? '',
      code: c.req.query('code'),
      error: c.req.query('error'),
    });
    c.header('Cache-Control', 'no-store');
    // Unknown (too old, or the address opened twice): to the page, which says so.
    return c.redirect(back ?? `${pageOrigin(c.req.url, c.req.header('X-Forwarded-Proto'))}/#/tg`, 302);
  });

  // The first time with Telegram (already a customer, or with an invitation):
  // username and password for their new account, and in.
  app.post(
    '/telegram/claim',
    zValidator(
      'json',
      z.object({
        telegram: telegramProof,
        username: z.string().trim().min(3).max(32),
        password: accountPassword,
        code: inviteCode.optional(),
      }),
    ),
    async (c) => {
      const db = c.get('db');
      const env = c.get('env');
      const { code, ...input } = c.req.valid('json');
      const row = code ? await signUp(db, { ...input, code }) : await claimAccount(db, env, input);
      const userRow = await getUser(db, row.telegramId);
      await claimWhatIsTheirs(db, env, row.telegramId, userRow?.username ?? null);
      return c.json(await accountResponse(db, env, row), 201);
    },
  );

  // Signing in with Telegram; with no account yet, `make_account` (with an
  // invitation, or already a customer): the page asks for a password next.
  app.post('/telegram', zValidator('json', z.object({ telegram: telegramProof, code: inviteCode.optional() })), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const { telegram, code } = c.req.valid('json');
    const row = await accountByTelegram(db, env, telegram, code);
    const userRow = await getUser(db, row.telegramId);
    await claimWhatIsTheirs(db, env, row.telegramId, userRow?.username ?? null);
    return c.json(await accountResponse(db, env, row));
  });

  return app;
}
