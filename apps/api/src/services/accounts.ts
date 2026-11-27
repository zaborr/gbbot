import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { TelegramLoginData } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { invites, shops, users, webAdmins } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { signSession } from '../auth/jwt.js';
import { assertUsernameFree, forgetSessions, hashPassword, verifyPassword, accountOf } from './webAdmins.js';
import { keyHash, markKeyed } from './webKeys.js';
import { addVipBy } from './vip.js';

// --- Telegram's "Log in with Telegram" (the login bot) -------------------------

/** How old the button's answer may be: it is pressed as the last step. */
const LOGIN_MAX_AGE_S = 3600;

export interface TelegramIdentity {
  id: number;
  firstName: string;
  username: string | null;
}

/**
 * Checks what the login button handed the page, as Telegram documents it: an
 * HMAC-SHA-256 of the sorted "key=value" lines, keyed with SHA-256 of the login
 * bot's token. Proves which Telegram account pressed it.
 */
export function verifyTelegramLogin(
  env: Env,
  data: TelegramLoginData,
  now = Date.now(),
): TelegramIdentity {
  const bad = ApiError.unauthorized('Telegram could not confirm who you are. Try again.');
  if (!env.LOGIN_BOT_TOKEN) throw new ApiError(503, 'no_login_bot', 'Logging in with Telegram is not set up');
  const { hash, ...rest } = data;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw bad;
  const check = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(env.LOGIN_BOT_TOKEN).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw bad;
  const authDate = Number(rest.auth_date);
  const id = Number(rest.id);
  if (!Number.isFinite(authDate) || now / 1000 - authDate > LOGIN_MAX_AGE_S || !Number.isSafeInteger(id) || id <= 0) {
    throw bad;
  }
  const name = [rest.first_name, rest.last_name].filter((p) => typeof p === 'string' && p !== '').join(' ');
  return {
    id,
    firstName: name || String(id),
    username: typeof rest.username === 'string' && rest.username !== '' ? rest.username : null,
  };
}

/** The person's Telegram names, as Telegram gave them (kept up to date, like the bot does). */
async function rememberTelegramUser(db: Database, who: TelegramIdentity): Promise<void> {
  await db
    .insert(users)
    .values({ telegramId: who.id, firstName: who.firstName, username: who.username })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: { firstName: who.firstName, username: who.username },
    });
}

// --- Invitations -----------------------------------------------------------------

const WORDS = [
  'amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'iris', 'juniper',
  'kelp', 'lumen', 'maple', 'nectar', 'olive', 'pebble', 'quartz', 'river', 'sage', 'tundra',
  'umber', 'violet', 'willow', 'yarrow', 'zephyr', 'coral', 'dune', 'fern', 'heath', 'lotus',
];
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * An invitation code: word-XXXXX-XXXXX-XXXXX-word (75+ bits), to copy and
 * paste. 29 characters: fits Telegram's start links (64).
 */
function newInviteCode(): string {
  const bytes = randomBytes(17);
  const block = (from: number): string =>
    Array.from({ length: 5 }, (_, i) => CHARS[bytes[from + i]! % CHARS.length]).join('');
  return `${WORDS[bytes[15]! % WORDS.length]}-${block(0)}-${block(5)}-${block(10)}-${WORDS[bytes[16]! % WORDS.length]}`;
}

export type InviteRow = typeof invites.$inferSelect;

export async function createInvite(
  db: Database,
  input: {
    kind: 'group' | 'personal';
    shopId: string;
    createdBy: number;
    days: number;
    telegramId?: number;
    vip?: 'none' | 'shop' | 'platform';
  },
): Promise<{ id: string; code: string; expiresAt: Date }> {
  if (input.kind === 'personal') {
    const id = input.telegramId!;
    if (await accountOf(db, id)) {
      throw ApiError.conflict('has_account', 'This person already has a web account');
    }
    // Someone who never opened the bot: known by their ID until Telegram names them.
    await db.insert(users).values({ telegramId: id, firstName: String(id), username: null }).onConflictDoNothing();
  }
  const code = newInviteCode();
  const expiresAt = new Date(Date.now() + input.days * 24 * 3600_000);
  const [row] = await db
    .insert(invites)
    .values({
      hash: keyHash(code),
      kind: input.kind,
      telegramId: input.kind === 'personal' ? input.telegramId! : null,
      shopId: input.shopId,
      vip: input.kind === 'personal' ? (input.vip ?? 'none') : 'none',
      createdBy: input.createdBy,
      expiresAt,
    })
    .returning({ id: invites.id });
  return { id: row!.id, code, expiresAt };
}

/** A usable invitation (not taken back, not expired, a personal one not used yet), or nothing. */
async function usableInvite(db: Database, code: string, now = new Date()): Promise<InviteRow | undefined> {
  const row = await db.query.invites.findFirst({ where: eq(invites.hash, keyHash(code)) });
  if (!row || row.revokedAt || row.expiresAt <= now) return undefined;
  if (row.kind === 'personal' && row.uses > 0) return undefined;
  return row;
}

/** Every failure gives this one answer: nothing to learn from trying codes. */
const badInvite = (): ApiError =>
  ApiError.unauthorized('This invitation is not valid (wrong, used, taken back or expired)');

/** What the sign-up page shows for a code: a group's, or whose personal one it is. */
export async function inviteInfo(
  db: Database,
  code: string,
): Promise<{ kind: 'group' | 'personal'; name: string | null }> {
  const row = await usableInvite(db, code);
  if (!row) throw badInvite();
  if (row.kind === 'group') return { kind: 'group', name: null };
  const user = await db.query.users.findFirst({ where: eq(users.telegramId, row.telegramId!) });
  const name = user ? (user.username ? `${user.firstName} (@${user.username})` : user.firstName) : String(row.telegramId);
  return { kind: 'personal', name };
}

export async function listInvites(db: Database, shopId: string): Promise<InviteRow[]> {
  return db.query.invites.findMany({
    where: eq(invites.shopId, shopId),
    orderBy: desc(invites.createdAt),
    limit: 50,
  });
}

export async function revokeInvite(db: Database, shopId: string, id: string): Promise<void> {
  const [row] = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, id), eq(invites.shopId, shopId)))
    .returning({ id: invites.id });
  if (!row) throw ApiError.notFound('Invitation not found');
}

// --- Accounts --------------------------------------------------------------------

export type AccountRow = typeof webAdmins.$inferSelect & { telegramId: number };

/**
 * Opens a web account with an invitation. Group: their Telegram must come
 * from the login bot (nobody else can tell who they are). Personal: tied to
 * the ID the staff gave; if Telegram also confirms it, it must be the same.
 */
export async function signUp(
  db: Database,
  env: Env,
  input: { code: string; username: string; password: string; telegram?: TelegramLoginData },
): Promise<AccountRow> {
  const who = input.telegram ? verifyTelegramLogin(env, input.telegram) : undefined;
  const username = input.username.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const account = await db.transaction(async (tx) => {
    const found = await usableInvite(tx as unknown as Database, input.code);
    if (!found) throw badInvite();
    // One at a time per invitation (a personal one is used once).
    const [invite] = await tx.select().from(invites).where(eq(invites.id, found.id)).for('update');
    if (!invite || (invite.kind === 'personal' && invite.uses > 0)) throw badInvite();
    let telegramId: number;
    let linkState: 'confirmed' | 'staff';
    if (invite.kind === 'group') {
      if (!who) throw ApiError.badRequest('telegram_needed', 'Link your Telegram to finish');
      telegramId = who.id;
      linkState = 'confirmed';
    } else {
      telegramId = invite.telegramId!;
      if (who && who.id !== telegramId) {
        throw ApiError.conflict('telegram_mismatch', 'This invitation is for another Telegram account');
      }
      linkState = who ? 'confirmed' : 'staff';
    }
    if (who) await rememberTelegramUser(tx as unknown as Database, who);
    if (await accountOf(tx as unknown as Database, telegramId)) {
      throw ApiError.conflict('has_account', 'You already have a web account: sign in');
    }
    await assertUsernameFree(tx as unknown as Database, username);
    const [row] = await tx
      .insert(webAdmins)
      .values({
        username,
        role: 'linked',
        telegramId,
        passwordHash,
        totpSecret: null,
        linkState,
        linkedBy: linkState === 'staff' ? invite.createdBy : null,
        inviteId: invite.id,
      })
      .returning();
    await tx
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1`, lastUsedAt: new Date() })
      .where(eq(invites.id, invite.id));
    return { row: row!, invite };
  });
  // A personal invitation's VIP, where it was made (or everywhere).
  if (account.invite.vip !== 'none' && account.invite.shopId) {
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, account.invite.shopId) });
    if (shop) await addVipBy(db, shop, account.row.telegramId!, account.invite.vip);
  }
  markKeyed(account.row.telegramId!);
  return account.row as AccountRow;
}

/**
 * Their own web account, for someone already in: from Telegram (the Mini App:
 * confirmed) or a web key (the ID the staff gave, unless the login bot confirms it).
 */
export async function createOwnAccount(
  db: Database,
  env: Env,
  input: {
    telegramId: number;
    fromTelegram: boolean;
    keyGivenBy: number | null;
    username: string;
    password: string;
    telegram?: TelegramLoginData;
  },
): Promise<AccountRow> {
  const who = input.telegram ? verifyTelegramLogin(env, input.telegram) : undefined;
  if (who && who.id !== input.telegramId) {
    throw ApiError.conflict('telegram_mismatch', 'That Telegram account is not the one you are signed in with');
  }
  if (await accountOf(db, input.telegramId)) {
    throw ApiError.conflict('has_account', 'You already have a web account: sign in');
  }
  const username = input.username.trim().toLowerCase();
  await assertUsernameFree(db, username);
  if (who) await rememberTelegramUser(db, who);
  const confirmed = input.fromTelegram || who !== undefined;
  const [row] = await db
    .insert(webAdmins)
    .values({
      username,
      role: 'linked',
      telegramId: input.telegramId,
      passwordHash: await hashPassword(input.password),
      totpSecret: null,
      linkState: confirmed ? 'confirmed' : 'staff',
      linkedBy: confirmed ? null : input.keyGivenBy,
    })
    .returning();
  markKeyed(input.telegramId);
  return row as AccountRow;
}

/** The login bot proved their Telegram: the account tied to it, now confirmed. */
export async function accountByTelegram(db: Database, env: Env, telegram: TelegramLoginData): Promise<AccountRow> {
  const who = verifyTelegramLogin(env, telegram);
  const row = await accountOf(db, who.id);
  if (!row) throw ApiError.notFound('There is no web account for this Telegram yet: you need an invitation');
  await rememberTelegramUser(db, who);
  if (row.linkState !== 'confirmed') {
    await db.update(webAdmins).set({ linkState: 'confirmed', linkedBy: null }).where(eq(webAdmins.id, row.id));
  }
  return { ...row, linkState: 'confirmed', telegramId: who.id } as AccountRow;
}

/**
 * Confirms the Telegram an account was tied to by the staff. Another Telegram
 * pressing it: refused (the staff gave a wrong ID; whoever tied it can see it).
 */
export async function confirmLink(db: Database, env: Env, accountId: number, telegram: TelegramLoginData): Promise<void> {
  const who = verifyTelegramLogin(env, telegram);
  const row = await db.query.webAdmins.findFirst({ where: eq(webAdmins.id, accountId) });
  if (!row || row.telegramId === null) throw ApiError.notFound('Account not found');
  if (row.telegramId !== who.id) {
    throw ApiError.conflict('telegram_mismatch', 'This account is tied to another Telegram account. Ask whoever invited you.');
  }
  await rememberTelegramUser(db, who);
  await db.update(webAdmins).set({ linkState: 'confirmed', linkedBy: null }).where(eq(webAdmins.id, row.id));
}

/**
 * A new password. With the current one, or proved by Telegram (the login bot,
 * or a Telegram session). Every other session of the account ends.
 */
export async function setPassword(
  db: Database,
  env: Env,
  input: { telegramId: number; password: string; current?: string; telegram?: TelegramLoginData; telegramSession: boolean },
): Promise<AccountRow> {
  const row = await accountOf(db, input.telegramId);
  if (!row) throw ApiError.notFound('You have no web account');
  let proved = input.telegramSession;
  if (!proved && input.telegram) proved = verifyTelegramLogin(env, input.telegram).id === input.telegramId;
  if (!proved && input.current !== undefined) proved = await verifyPassword(input.current, row.passwordHash);
  if (!proved) throw ApiError.forbidden('Wrong current password');
  const [updated] = await db
    .update(webAdmins)
    .set({ passwordHash: await hashPassword(input.password), sessionVersion: sql`${webAdmins.sessionVersion} + 1` })
    .where(eq(webAdmins.id, row.id))
    .returning();
  forgetSessions();
  return updated as AccountRow;
}

/**
 * A forgotten password while Telegram cannot prove who they are (both bots
 * down): platform admins and supervisors give a new one, shown once.
 */
export async function resetAccountPassword(db: Database, telegramId: number): Promise<{ username: string; password: string }> {
  const row = await accountOf(db, telegramId);
  if (!row) throw ApiError.notFound('This person has no web account');
  if (row.totpSecret !== null) {
    throw ApiError.conflict('manages', 'This account manages: reset it in Plataforma → Cuentas web');
  }
  const password = randomBytes(9).toString('base64url');
  await db
    .update(webAdmins)
    .set({ passwordHash: await hashPassword(password), sessionVersion: sql`${webAdmins.sessionVersion} + 1` })
    .where(eq(webAdmins.id, row.id));
  forgetSessions();
  return { username: row.username, password };
}

/** A customer's session: the customer side only, whatever the person manages. */
export async function accountSession(
  env: Env,
  row: AccountRow,
): Promise<{ token: string; expiresAt: Date }> {
  return signSession(
    { sub: row.telegramId, role: 'customer', wid: row.id, ver: row.sessionVersion, cs: true },
    env.JWT_SECRET,
    env.WEB_ACCOUNT_SESSION_DAYS * 24 * 3600,
  );
}
