import { asc, eq } from 'drizzle-orm';
import type { AddCreatorAccountRequest, CreatorAccountInfo, CreatorLoginStep } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { creatorAccounts } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { open, seal, secretKey } from '../lib/secretBox.js';
import { tr } from '../i18n/messages.js';
import {
  ACCOUNT_CLOSED,
  CreatorError,
  SESSION_GONE,
  creatorApi,
  loginError,
  type CreatorApi,
  type CreatorCredentials,
  type CreatorUser,
} from './creator.js';
import { notifyPlatform } from './webNotices.js';

type AccountRow = typeof creatorAccounts.$inferSelect;

const CHECK_EVERY_HOURS = 6;

/** Sign-ins in progress: account → the creator service's login id. */
const logins = new Map<number, string>();

const maskPhone = (phone: string): string => `•••${phone.slice(-3)}`;

const toInfo = (row: AccountRow): CreatorAccountInfo => ({
  id: row.id,
  phone: maskPhone(row.phone),
  status: row.status,
  telegramId: row.telegramId,
  username: row.username,
  firstName: row.firstName,
  createdAt: row.createdAt.toISOString(),
  checkedAt: row.checkedAt?.toISOString() ?? null,
  lastError: row.lastError,
});

export async function listCreatorAccounts(db: Database): Promise<CreatorAccountInfo[]> {
  const rows = await db.select().from(creatorAccounts).orderBy(asc(creatorAccounts.id));
  return rows.map(toInfo);
}

async function findAccount(db: Database, id: number): Promise<AccountRow> {
  const row = await db.query.creatorAccounts.findFirst({ where: eq(creatorAccounts.id, id) });
  if (!row) throw ApiError.notFound('Creator account not found');
  return row;
}

/** How to act as an account; null when it is not signed in. */
export function credentialsOf(env: Env, row: AccountRow): CreatorCredentials | null {
  const key = secretKey(env);
  const apiHash = open(key, row.apiHash);
  const session = row.session ? open(key, row.session) : null;
  return apiHash && session ? { apiId: row.apiId, apiHash, session } : null;
}

async function startLogin(
  db: Database,
  env: Env,
  row: AccountRow,
  api: CreatorApi,
): Promise<CreatorLoginStep> {
  const apiHash = open(secretKey(env), row.apiHash);
  if (!apiHash) throw ApiError.conflict('creator_key', 'The account data cannot be read: remove it and add it again');
  try {
    const { loginId, viaApp } = await api.loginStart({ apiId: row.apiId, apiHash, phone: row.phone });
    logins.set(row.id, loginId);
    return { id: row.id, step: 'code', viaApp };
  } catch (error) {
    throw loginError(error);
  }
}

/** A new account: it is stored, then Telegram sends it a code. */
export async function addCreatorAccount(
  db: Database,
  env: Env,
  input: AddCreatorAccountRequest,
  api: CreatorApi = creatorApi(env),
): Promise<CreatorLoginStep> {
  const existing = await db.query.creatorAccounts.findFirst({ where: eq(creatorAccounts.phone, input.phone) });
  if (existing) throw ApiError.conflict('creator_exists', 'That phone number is already a creator account');
  const [row] = await db
    .insert(creatorAccounts)
    .values({ phone: input.phone, apiId: input.apiId, apiHash: seal(secretKey(env), input.apiHash), status: 'login' })
    .returning();
  try {
    return await startLogin(db, env, row!, api);
  } catch (error) {
    // Nothing worked (wrong number, wrong api_id…): do not keep it.
    await db.delete(creatorAccounts).where(eq(creatorAccounts.id, row!.id));
    throw error;
  }
}

/** Telegram asks for the code again (or signing in was left halfway). */
export async function reloginCreatorAccount(
  db: Database,
  env: Env,
  id: number,
  api: CreatorApi = creatorApi(env),
): Promise<CreatorLoginStep> {
  return startLogin(db, env, await findAccount(db, id), api);
}

async function signedIn(db: Database, env: Env, id: number, session: string, user: CreatorUser): Promise<CreatorLoginStep> {
  logins.delete(id);
  await db
    .update(creatorAccounts)
    .set({
      session: seal(secretKey(env), session),
      status: 'ok',
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
      checkedAt: new Date(),
      lastError: null,
    })
    .where(eq(creatorAccounts.id, id));
  return { id, step: 'done' };
}

function pendingLogin(id: number): string {
  const loginId = logins.get(id);
  if (!loginId) throw ApiError.conflict('creator_expired', 'The code has expired: ask for a new one');
  return loginId;
}

export async function submitCreatorCode(
  db: Database,
  env: Env,
  id: number,
  code: string,
  api: CreatorApi = creatorApi(env),
): Promise<CreatorLoginStep> {
  await findAccount(db, id);
  try {
    const result = await api.loginCode(pendingLogin(id), code);
    if ('password' in result) return { id, step: 'password', hint: result.hint };
    return await signedIn(db, env, id, result.session, result.user);
  } catch (error) {
    throw loginError(error);
  }
}

export async function submitCreatorPassword(
  db: Database,
  env: Env,
  id: number,
  password: string,
  api: CreatorApi = creatorApi(env),
): Promise<CreatorLoginStep> {
  await findAccount(db, id);
  try {
    const result = await api.loginPassword(pendingLogin(id), password);
    return await signedIn(db, env, id, result.session, result.user);
  } catch (error) {
    throw loginError(error);
  }
}

export async function removeCreatorAccount(db: Database, id: number): Promise<void> {
  await findAccount(db, id);
  logins.delete(id);
  await db.delete(creatorAccounts).where(eq(creatorAccounts.id, id));
}

/**
 * Marks an account after Telegram refused it: it must sign in again, or it
 * was closed. The platform administrators are told once. Returns whether the
 * error was about the account (and not, say, the network).
 */
export async function accountFailed(db: Database, env: Env, row: AccountRow, error: unknown): Promise<boolean> {
  if (!(error instanceof CreatorError)) return false;
  const status = ACCOUNT_CLOSED.has(error.reason) ? 'closed' : SESSION_GONE.has(error.reason) ? 'login' : null;
  if (!status) return false;
  await db
    .update(creatorAccounts)
    .set({ status, checkedAt: new Date(), lastError: error.reason, ...(status === 'closed' ? { session: null } : {}) })
    .where(eq(creatorAccounts.id, row.id));
  if (row.status !== status) {
    const name = row.username ? `@${row.username}` : maskPhone(row.phone);
    await notifyPlatform(db, env, (lang) =>
      tr(lang, status === 'closed' ? 'creator.closed' : 'creator.needsLogin', { account: name }),
    ).catch(() => undefined);
  }
  return true;
}

/** Asks Telegram, as each signed-in account, whether it still works. */
export async function checkCreatorAccounts(db: Database, env: Env, api: CreatorApi = creatorApi(env)): Promise<void> {
  const rows = await db.select().from(creatorAccounts).where(eq(creatorAccounts.status, 'ok'));
  for (const row of rows) {
    const credentials = credentialsOf(env, row);
    if (!credentials) continue;
    try {
      const { user } = await api.me(credentials);
      await db
        .update(creatorAccounts)
        .set({ checkedAt: new Date(), lastError: null, username: user.username, firstName: user.firstName })
        .where(eq(creatorAccounts.id, row.id));
    } catch (error) {
      if (!(await accountFailed(db, env, row, error))) {
        // Network or the service down: try again next time.
        console.warn('Could not check a creator account:', error instanceof Error ? error.message : error);
      }
    }
  }
}

export function scheduleCreatorChecks(db: Database, env: Env): void {
  const run = (): void =>
    void checkCreatorAccounts(db, env).catch((error: unknown) => console.error('Creator account check failed:', error));
  setTimeout(run, 60_000).unref();
  setInterval(run, CHECK_EVERY_HOURS * 60 * 60 * 1000).unref();
}
