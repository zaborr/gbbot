import { createHmac } from 'node:crypto';
import type { Env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

/** How the creator service signs in as an account (sent with each request). */
export interface CreatorCredentials {
  apiId: number;
  apiHash: string;
  session: string;
}

export interface CreatorUser {
  id: number;
  username: string | null;
  firstName: string | null;
}

/** What Telegram (or the creator service) refused: `PHONE_CODE_INVALID`, `FLOOD_WAIT`… */
export class CreatorError extends Error {
  constructor(
    readonly reason: string,
    readonly seconds?: number,
  ) {
    super(`Creator service: ${reason}`);
    this.name = 'CreatorError';
  }
}

/** Telegram no longer accepts the session: the account must sign in again. */
export const SESSION_GONE = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
]);
/** Telegram closed the account. */
export const ACCOUNT_CLOSED = new Set(['USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'PHONE_NUMBER_BANNED']);

/** The calls the API makes to the creator service (a fake one in tests). */
export interface CreatorApi {
  loginStart(input: { apiId: number; apiHash: string; phone: string }): Promise<{ loginId: string; viaApp: boolean }>;
  loginCode(loginId: string, code: string): Promise<{ done: true; session: string; user: CreatorUser } | { password: true; hint: string | null }>;
  loginPassword(loginId: string, password: string): Promise<{ done: true; session: string; user: CreatorUser }>;
  me(account: CreatorCredentials): Promise<{ user: CreatorUser }>;
  /** Any other action of the service (see creator/src/actions.mjs). */
  call<T>(path: string, body: Record<string, unknown>): Promise<T>;
}

/** The key both sides derive from JWT_SECRET. */
export function creatorKey(env: Pick<Env, 'JWT_SECRET'>): string {
  return createHmac('sha256', env.JWT_SECRET).update('gb-creator').digest('hex');
}

export function creatorApi(env: Env, fetchImpl: typeof fetch = fetch): CreatorApi {
  const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${env.CREATOR_URL.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-creator-key': creatorKey(env) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ApiError(503, 'creator_down', 'The creator service is not running');
    }
    const data = (await res.json().catch(() => ({}))) as { reason?: string; seconds?: number };
    if (!res.ok) throw new CreatorError(data.reason ?? `HTTP ${res.status}`, data.seconds);
    return data as T;
  };
  return {
    loginStart: (input) => call('/login/start', input),
    loginCode: (loginId, code) => call('/login/code', { loginId, code }),
    loginPassword: (loginId, password) => call('/login/password', { loginId, password }),
    me: (account) => call('/me', { ...account }),
    call,
  };
}

/** A refused sign-in step as an error the panel can show. */
export function loginError(error: unknown): unknown {
  if (!(error instanceof CreatorError)) return error;
  switch (error.reason) {
    case 'PHONE_NUMBER_INVALID':
      return ApiError.badRequest('creator_phone', 'Telegram does not know this phone number');
    case 'PHONE_NUMBER_BANNED':
      return ApiError.badRequest('creator_banned', 'Telegram has closed this phone number');
    case 'API_ID_INVALID':
    case 'API_ID_PUBLISHED_FLOOD':
      return ApiError.badRequest('creator_api', 'Telegram does not accept this api_id and api_hash');
    case 'PHONE_CODE_INVALID':
    case 'PHONE_CODE_EMPTY':
      return ApiError.badRequest('creator_code', 'The code is not right');
    case 'PHONE_CODE_EXPIRED':
    case 'LOGIN_EXPIRED':
      return ApiError.badRequest('creator_expired', 'The code has expired: ask for a new one');
    case 'PASSWORD_HASH_INVALID':
      return ApiError.badRequest('creator_password', 'The password is not right');
    case 'SIGN_UP_REQUIRED':
      return ApiError.badRequest('creator_signup', 'This number has no Telegram account: create it in the app first');
    case 'FLOOD_WAIT':
      return ApiError.badRequest('creator_flood', `Telegram asks to wait ${error.seconds ?? '?'} seconds`);
    default:
      return ApiError.badRequest('creator_error', `Telegram refused it (${error.reason})`);
  }
}
