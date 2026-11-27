import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

/**
 * "Log in with Telegram" through the login bot (a bot apart from the shop's),
 * with Telegram's OpenID Connect: the page opens Telegram's window, Telegram
 * sends the person back here with a code, the server swaps it (with the bot's
 * client secret and PKCE) for a signed ID token and checks it against
 * Telegram's keys. The page then asks whether it is done and hands the
 * one-time proof to the sign-up, sign-in or confirmation it is doing.
 * Nothing from Telegram runs in our pages.
 */

const ISSUER = 'https://oauth.telegram.org';
const AUTH_URL = `${ISSUER}/auth`;
const TOKEN_URL = `${ISSUER}/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
/** How long a started login (and then its proof) is kept. */
const TTL_MS = 10 * 60_000;

export interface TelegramIdentity {
  id: number;
  firstName: string;
  username: string | null;
}

interface Pending {
  verifier: string;
  redirectUri: string;
  until: number;
  identity?: TelegramIdentity;
  failed?: string;
}

const pending = new Map<string, Pending>();

/** Tests: Telegram's token endpoint and keys, faked. */
let transport: { fetch: typeof fetch; keys: JWTVerifyGetKey | null } = { fetch: (...a) => fetch(...a), keys: null };
export function setTelegramLoginTransport(next: { fetch: typeof fetch; keys: JWTVerifyGetKey }): void {
  transport = next;
}
const keys = (): JWTVerifyGetKey => (transport.keys ??= createRemoteJWKSet(new URL(JWKS_URL)));

const b64url = (buf: Buffer): string => buf.toString('base64url');

function sweep(now: number): void {
  for (const [k, v] of pending) if (v.until <= now) pending.delete(k);
}

export function telegramLoginEnabled(env: Env): boolean {
  return env.LOGIN_BOT_CLIENT_ID !== undefined && Boolean(env.LOGIN_BOT_CLIENT_SECRET);
}

/** Starts a login: the address of Telegram's window, and the state the page waits on. */
export function startTelegramLogin(env: Env, origin: string, now = Date.now()): { url: string; state: string } {
  if (!telegramLoginEnabled(env)) throw new ApiError(503, 'no_login_bot', 'Logging in with Telegram is not set up');
  sweep(now);
  if (pending.size > 5000) throw new ApiError(429, 'busy', 'Too many logins at once. Try again in a minute.');
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  // Back to the same domain the page is on (each one is an Allowed URL in @BotFather).
  const redirectUri = `${origin.replace(/\/+$/, '')}/api/auth/telegram/callback`;
  pending.set(state, { verifier, redirectUri, until: now + TTL_MS });
  const params = new URLSearchParams({
    client_id: String(env.LOGIN_BOT_CLIENT_ID),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  return { url: `${AUTH_URL}?${params.toString()}`, state };
}

/** Telegram sends the person back: swap the code for the ID token and check it. */
export async function finishTelegramLogin(
  env: Env,
  input: { state: string; code?: string | undefined; error?: string | undefined },
  now = Date.now(),
): Promise<boolean> {
  const entry = pending.get(input.state);
  if (!entry || entry.until <= now || entry.identity || entry.failed) return false;
  if (!input.code) {
    entry.failed = input.error ?? 'cancelled';
    return false;
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
    entry.identity = { id, firstName: name, username };
    entry.until = now + TTL_MS;
    return true;
  } catch (error) {
    console.error('Telegram login failed:', error);
    entry.failed = 'failed';
    return false;
  }
}

/** Whether a started login is done, failed or still waiting (the page asks every few seconds). */
export function telegramLoginStatus(state: string, now = Date.now()): 'waiting' | 'ready' | 'failed' {
  const entry = pending.get(state);
  if (!entry || entry.until <= now) return 'failed';
  if (entry.identity) return 'ready';
  return entry.failed ? 'failed' : 'waiting';
}

/** The proved Telegram of a finished login, without using it up (to decide what comes next). */
export function peekTelegramIdentity(state: string, now = Date.now()): TelegramIdentity {
  const entry = pending.get(state);
  if (!entry || entry.until <= now || !entry.identity) {
    throw ApiError.unauthorized('Telegram could not confirm who you are. Try again.');
  }
  return entry.identity;
}

/** The proved Telegram of a finished login, used once. */
export function takeTelegramIdentity(state: string, now = Date.now()): TelegramIdentity {
  const entry = pending.get(state);
  if (!entry || entry.until <= now || !entry.identity) {
    throw ApiError.unauthorized('Telegram could not confirm who you are. Try again.');
  }
  pending.delete(state);
  return entry.identity;
}
