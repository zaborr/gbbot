import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { webAdmins } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';

/**
 * Platform super-admins who sign in on the web: username, password and a code
 * from an authenticator app. They are created and reset on the server with
 * the command line (see cli.ts), so losing access never depends on Telegram.
 */

export type WebAdminRow = typeof webAdmins.$inferSelect;

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- TOTP (RFC 6238: 30-second steps, 6 digits, SHA-1, as every app uses) ---

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The 6-digit code of a 30-second step. */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const number = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(number % 1_000_000).padStart(6, '0');
}

export const currentStep = (now = Date.now()): number => Math.floor(now / 30_000);

/**
 * The step a code belongs to (this one, or one either side for clocks a bit
 * off), or null when it is wrong.
 */
export function matchTotp(secretBase32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const step = currentStep(now);
  for (const candidate of [step, step - 1, step + 1]) {
    const expected = Buffer.from(totpCode(secret, candidate));
    if (timingSafeEqual(expected, Buffer.from(code))) return candidate;
  }
  return null;
}

/** Link for authenticator apps (they read it as a QR or let you type the secret). */
export function otpauthUri(username: string, secret: string): string {
  return `otpauth://totp/GB:${encodeURIComponent(username)}?secret=${secret}&issuer=GB&digits=6&period=30`;
}

// --- Accounts ----------------------------------------------------------------

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

export interface NewCredentials {
  username: string;
  password: string;
  totpSecret: string;
  otpauth: string;
}

function newCredentials(): { password: string; totpSecret: string } {
  return {
    // 24 characters: strong enough that it never needs changing.
    password: randomBytes(18).toString('base64url'),
    totpSecret: base32Encode(randomBytes(20)),
  };
}

export async function createWebAdmin(db: Database, rawUsername: string): Promise<NewCredentials> {
  const username = rawUsername.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new Error('Use 3–32 characters: letters, numbers, ".", "_" or "-"');
  }
  const taken = await db.query.webAdmins.findFirst({ where: eq(webAdmins.username, username) });
  if (taken) throw new Error(`"${username}" already exists (use reset)`);
  const { password, totpSecret } = newCredentials();
  await db.insert(webAdmins).values({
    username,
    passwordHash: await hashPassword(password),
    totpSecret,
  });
  return { username, password, totpSecret, otpauth: otpauthUri(username, totpSecret) };
}

/** New password and authenticator secret; every open session is closed. */
export async function resetWebAdmin(db: Database, rawUsername: string): Promise<NewCredentials> {
  const username = rawUsername.trim().toLowerCase();
  const { password, totpSecret } = newCredentials();
  const [row] = await db
    .update(webAdmins)
    .set({
      passwordHash: await hashPassword(password),
      totpSecret,
      totpLastStep: 0,
      sessionVersion: sql`${webAdmins.sessionVersion} + 1`,
      failedAttempts: 0,
      lockedUntil: null,
    })
    .where(eq(webAdmins.username, username))
    .returning();
  if (!row) throw new Error(`There is no "${username}"`);
  forgetSessions();
  return { username, password, totpSecret, otpauth: otpauthUri(username, totpSecret) };
}

export async function removeWebAdmin(db: Database, rawUsername: string): Promise<void> {
  const username = rawUsername.trim().toLowerCase();
  const deleted = await db.delete(webAdmins).where(eq(webAdmins.username, username)).returning();
  if (deleted.length === 0) throw new Error(`There is no "${username}"`);
  forgetSessions();
}

export async function listWebAdmins(db: Database): Promise<WebAdminRow[]> {
  return db.select().from(webAdmins).orderBy(asc(webAdmins.username));
}

// --- Signing in ----------------------------------------------------------------

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

/**
 * Checks username, password and authenticator code. After 5 wrong attempts the
 * account waits 15 minutes. Every failure gives the same answer, so nobody
 * learns which part was wrong or whether the username exists.
 */
export async function signInWebAdmin(
  db: Database,
  rawUsername: string,
  password: string,
  code: string,
  now = new Date(),
): Promise<WebAdminRow> {
  const wrong = ApiError.unauthorized('Wrong username, password or code');
  const username = rawUsername.trim().toLowerCase();
  const row = await db.query.webAdmins.findFirst({ where: eq(webAdmins.username, username) });
  if (!row) {
    // Same work as a real check, so timing does not reveal missing users.
    await hashPassword(password);
    throw wrong;
  }
  if (row.lockedUntil && row.lockedUntil > now) {
    throw new ApiError(429, 'account_locked', 'Too many wrong attempts. Try again in 15 minutes.');
  }
  const passwordOk = await verifyPassword(password, row.passwordHash);
  const step = passwordOk ? matchTotp(row.totpSecret, code.trim(), now.getTime()) : null;
  if (!passwordOk || step === null || step <= row.totpLastStep) {
    const failures = row.failedAttempts + 1;
    await db
      .update(webAdmins)
      .set(
        failures >= MAX_FAILURES
          ? { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) }
          : { failedAttempts: failures },
      )
      .where(eq(webAdmins.id, row.id));
    throw wrong;
  }
  const [updated] = await db
    .update(webAdmins)
    .set({ totpLastStep: step, failedAttempts: 0, lockedUntil: null, lastLoginAt: now })
    .where(eq(webAdmins.id, row.id))
    .returning();
  return updated ?? row;
}

// --- Sessions ------------------------------------------------------------------

/** Session ids of web admins are negative, so they never match a Telegram user. */
export const webSessionId = (adminId: number): number => -adminId;
export const isWebSession = (sub: number): boolean => sub < 0;

const sessionCache = new Map<number, { version: number | null; until: number }>();
const forgetSessions = (): void => sessionCache.clear();

/**
 * Whether a web session is still good: the account exists and was not reset
 * since. Checked on each request (cached for a few seconds).
 */
export async function webSessionValid(db: Database, sub: number, version: number | undefined): Promise<boolean> {
  const id = -sub;
  const now = Date.now();
  let cached = sessionCache.get(id);
  if (!cached || cached.until < now) {
    const row = await db.query.webAdmins.findFirst({
      where: eq(webAdmins.id, id),
      columns: { sessionVersion: true },
    });
    cached = { version: row?.sessionVersion ?? null, until: now + 10_000 };
    sessionCache.set(id, cached);
  }
  return cached.version !== null && cached.version === version;
}
