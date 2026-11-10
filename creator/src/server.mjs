// Creator service: acts as the creator accounts (Telegram user accounts).
// Internal only: the API calls it on the Docker network with a key derived
// from JWT_SECRET. Nothing is kept on disk; sessions come with each request.

import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import telegram from 'telegram';
import { actions } from './actions.mjs';

const { TelegramClient, Api, Logger, sessions, password } = telegram;
const { StringSession } = sessions;

const PORT = Number(process.env.CREATOR_PORT ?? 3100);
const LOGIN_TTL_MS = 10 * 60 * 1000;

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set: the creator service cannot check who calls it.');
  process.exit(1);
}
const KEY = createHmac('sha256', process.env.JWT_SECRET).update('gb-creator').digest('hex');

/** A Telegram error the API can act on: `PHONE_CODE_INVALID`, `FLOOD_WAIT`… */
export class CreatorError extends Error {
  constructor(reason, extra = {}) {
    super(reason);
    this.reason = reason;
    this.extra = extra;
  }
}

/** The reason Telegram gives (errorMessage), or the message. */
function reasonOf(error) {
  if (error instanceof CreatorError) return { reason: error.reason, ...error.extra };
  if (typeof error?.seconds === 'number') return { reason: 'FLOOD_WAIT', seconds: error.seconds };
  if (typeof error?.errorMessage === 'string') return { reason: error.errorMessage };
  return { reason: 'ERROR', message: error instanceof Error ? error.message : String(error) };
}

export function makeClient(apiId, apiHash, session = '') {
  return new TelegramClient(new StringSession(session), Number(apiId), apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger('error'),
    deviceModel: 'GB server',
    systemVersion: 'Linux',
    appVersion: '1.0',
  });
}

/** Runs `fn` signed in as an account, then closes the connection. */
export async function withAccount({ apiId, apiHash, session }, fn) {
  const client = makeClient(apiId, apiHash, session);
  try {
    await client.connect();
    if (!(await client.checkAuthorization())) throw new CreatorError('AUTH_KEY_UNREGISTERED');
    return await fn(client);
  } finally {
    await client.destroy().catch(() => {});
  }
}

export function userOf(user) {
  return {
    id: Number(user.id.toString()),
    username: user.username ?? null,
    firstName: user.firstName ?? null,
  };
}

// --- signing in (phone → code → maybe the two-step password) ---

const logins = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, login] of logins) {
    if (now - login.at > LOGIN_TTL_MS) {
      logins.delete(id);
      void login.client.destroy().catch(() => {});
    }
  }
}, 60_000).unref();

function pendingLogin(loginId) {
  const login = logins.get(loginId);
  if (!login) throw new CreatorError('LOGIN_EXPIRED');
  return login;
}

async function finishLogin(loginId, login, user) {
  const session = login.client.session.save();
  logins.delete(loginId);
  await login.client.destroy().catch(() => {});
  return { done: true, session, user: userOf(user) };
}

const routes = {
  async '/login/start'({ apiId, apiHash, phone }) {
    const client = makeClient(apiId, apiHash);
    try {
      await client.connect();
      const sent = await client.sendCode({ apiId: Number(apiId), apiHash }, phone);
      const loginId = randomUUID();
      logins.set(loginId, { client, phone, phoneCodeHash: sent.phoneCodeHash, at: Date.now() });
      return { loginId, viaApp: sent.isCodeViaApp };
    } catch (error) {
      await client.destroy().catch(() => {});
      throw error;
    }
  },

  async '/login/code'({ loginId, code }) {
    const login = pendingLogin(loginId);
    try {
      const result = await login.client.invoke(
        new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode: code }),
      );
      if (result instanceof Api.auth.AuthorizationSignUpRequired) throw new CreatorError('SIGN_UP_REQUIRED');
      return await finishLogin(loginId, login, result.user);
    } catch (error) {
      if (error?.errorMessage !== 'SESSION_PASSWORD_NEEDED') throw error;
      const info = await login.client.invoke(new Api.account.GetPassword());
      return { password: true, hint: info.hint ?? null };
    }
  },

  async '/login/password'({ loginId, password: plain }) {
    const login = pendingLogin(loginId);
    const info = await login.client.invoke(new Api.account.GetPassword());
    const check = await password.computeCheck(info, plain);
    const result = await login.client.invoke(new Api.auth.CheckPassword({ password: check }));
    return finishLogin(loginId, login, result.user);
  },

  /** Who the account is: fails when the session no longer works. */
  async '/me'(account) {
    return withAccount(account, async (client) => ({ user: userOf(await client.getMe()) }));
  },

  ...actions,
};

function authorised(req) {
  const given = Buffer.from(String(req.headers['x-creator-key'] ?? ''));
  const expected = Buffer.from(KEY);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new CreatorError('TOO_LARGE');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || !authorised(req)) return send(res, 404, { reason: 'NOT_FOUND' });
  const route = routes[req.url ?? ''];
  if (!route) return send(res, 404, { reason: 'NOT_FOUND' });
  try {
    send(res, 200, await route(await readJson(req), { withAccount, CreatorError, Api }));
  } catch (error) {
    const reason = reasonOf(error);
    if (reason.reason === 'ERROR') console.error(`${req.url} failed:`, error);
    send(res, 400, reason);
  }
});

server.listen(PORT, () => console.log(`Creator service listening on ${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
