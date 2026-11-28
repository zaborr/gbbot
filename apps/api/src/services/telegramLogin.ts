import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

/**
 * "Log in with Telegram" through the login bot (a bot apart from the shop's),
 * with Telegram's OpenID Connect, in the same tab: the page goes to Telegram,
 * Telegram sends the person back here with a code, the server swaps it (with
 * the bot's client secret and PKCE) for a signed ID token, checks it against
 * Telegram's keys and sends the browser back to the page with a one-time
 * ticket. Only the browser Telegram sent back holds the ticket (not whoever
 * started the login), and the page hands it to the sign-up, sign-in or
 * confirmation it was doing (`context`, kept here meanwhile).
 * Nothing from Telegram runs in our pages.
 */

const ISSUER = 'https://oauth.telegram.org';
const AUTH_URL = `${ISSUER}/auth`;
const TOKEN_URL = `${ISSUER}/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
/** How long a started login (and then its proof) is kept. */
const TTL_MS = 10 * 60_000;
export const CALLBACK_PATH = '/api/auth/telegram/callback';

export interface TelegramIdentity {
  id: number;
  firstName: string;
  username: string | null;
}

interface Pending {
  verifier: string;
  redirectUri: string;
  until: number;
  context: string;
}

interface Ticket {
  until: number;
  context: string;
  identity?: TelegramIdentity;
  failed?: string;
}

/** Started logins, by the state sent to Telegram. */
const pending = new Map<string, Pending>();
/** Finished ones (or failed), by the ticket handed to the page. */
const tickets = new Map<string, Ticket>();

/** Tests: Telegram's token endpoint and keys, faked. */
let transport: { fetch: typeof fetch; keys: JWTVerifyGetKey | null } = { fetch: (...a) => fetch(...a), keys: null };
export function setTelegramLoginTransport(next: { fetch: typeof fetch; keys: JWTVerifyGetKey }): void {
  transport = next;
}
const keys = (): JWTVerifyGetKey => (transport.keys ??= createRemoteJWKSet(new URL(JWKS_URL)));

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sweep(now: number): void {
  for (const [k, v] of pending) if (v.until <= now) pending.delete(k);
  for (const [k, v] of tickets) if (v.until <= now) tickets.delete(k);
}

export function telegramLoginEnabled(env: Env): boolean {
  return env.LOGIN_BOT_CLIENT_ID !== undefined && Boolean(env.LOGIN_BOT_CLIENT_SECRET);
}

/**
 * Starts a login: the address of Telegram's page. `context` is what the page
 * was doing (it gets it back with the ticket, in whatever tab it lands).
 */
export function startTelegramLogin(env: Env, origin: string, context = '', now = Date.now()): { url: string } {
  if (!telegramLoginEnabled(env)) throw new ApiError(503, 'no_login_bot', 'Logging in with Telegram is not set up');
  sweep(now);
  if (pending.size + tickets.size > 5000) throw new ApiError(429, 'busy', 'Too many logins at once. Try again in a minute.');
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  // Back to the same domain the page is on (each one is an Allowed URL in @BotFather).
  const redirectUri = `${origin.replace(/\/+$/, '')}${CALLBACK_PATH}`;
  pending.set(state, { verifier, redirectUri, until: now + TTL_MS, context });
  const params = new URLSearchParams({
    client_id: String(env.LOGIN_BOT_CLIENT_ID),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  return { url: `${AUTH_URL}?${params.toString()}` };
}

/**
 * Telegram sends the person back: swap the code for the ID token and check it.
 * The page's address to send them on to (with the ticket), or null when the
 * login is unknown (too old, or used).
 */
export async function finishTelegramLogin(
  env: Env,
  input: { state: string; code?: string | undefined; error?: string | undefined },
  now = Date.now(),
): Promise<string | null> {
  const entry = pending.get(input.state);
  if (!entry || entry.until <= now) return null;
  pending.delete(input.state);
  const ticket = b64url(randomBytes(24));
  const done: Ticket = { until: now + TTL_MS, context: entry.context };
  tickets.set(ticket, done);
  const back = `${entry.redirectUri.slice(0, -CALLBACK_PATH.length)}/#/tg?t=${ticket}`;
  if (!input.code) {
    done.failed = input.error ?? 'cancelled';
    return back;
  }
  try {
    const res = await transport.fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${env.LOGIN_BOT_CLIENT_ID}:${env.LOGIN_BOT_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: entry.redirectUri,
        client_id: String(env.LOGIN_BOT_CLIENT_ID),
        code_verifier: entry.verifier,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: unknown };
    if (!res.ok || typeof body.id_token !== 'string') throw new Error(`token endpoint answered ${res.status}`);
    const { payload } = await jwtVerify(body.id_token, keys(), {
      issuer: ISSUER,
      audience: String(env.LOGIN_BOT_CLIENT_ID),
    });
    const id = Number(payload.id ?? payload.sub);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('no Telegram id in the token');
    const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : String(id);
    const username =
      typeof payload.preferred_username === 'string' && payload.preferred_username !== ''
        ? payload.preferred_username.replace(/^@/, '')
        : null;
    done.identity = { id, firstName: name, username };
  } catch (error) {
    console.error('Telegram login failed:', error);
    done.failed = 'failed';
  }
  return back;
}

/**
 * What the page gets back with its ticket: whether Telegram confirmed it, what
 * it was doing, and the Telegram @username (to suggest it as the account's).
 */
export function telegramLoginResult(
  ticket: string,
  now = Date.now(),
): { status: 'ready' | 'failed'; context: string; username: string | null } {
  const entry = tickets.get(ticket);
  if (!entry || entry.until <= now) return { status: 'failed', context: '', username: null };
  return entry.identity
    ? { status: 'ready', context: entry.context, username: entry.identity.username }
    : { status: 'failed', context: entry.context, username: null };
}

/** The proved Telegram of a finished login, without using it up (to decide what comes next). */
export function peekTelegramIdentity(ticket: string, now = Date.now()): TelegramIdentity {
  const entry = tickets.get(ticket);
  if (!entry || entry.until <= now || !entry.identity) {
    throw ApiError.unauthorized('Telegram could not confirm who you are. Try again.');
  }
  return entry.identity;
}

/** The proved Telegram of a finished login, used once. */
export function takeTelegramIdentity(ticket: string, now = Date.now()): TelegramIdentity {
  const entry = tickets.get(ticket);
  if (!entry || entry.until <= now || !entry.identity) {
    throw ApiError.unauthorized('Telegram could not confirm who you are. Try again.');
  }
  tickets.delete(ticket);
  return entry.identity;
}
