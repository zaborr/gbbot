import { z } from 'zod';
import { isoDateTime } from './common.js';

/** Telegram user id (numeric, 64-bit — kept as number to match Bot API). */
export const telegramUserId = z.number().int().positive();

/**
 * Someone typed into an admin or organiser list: a Telegram id or an
 * @username (the "@" is optional).
 */
export const personRef = z
  .string()
  .trim()
  .regex(/^(\d{1,15}|@?[A-Za-z][A-Za-z0-9_]{3,31})$/);
export type PersonRef = z.infer<typeof personRef>;

/** Splits person refs into ids and lowercase usernames (no "@"), without repeats. */
export function splitPersonRefs(refs: readonly string[]): { ids: number[]; usernames: string[] } {
  const ids = new Set<number>();
  const usernames = new Set<string>();
  for (const raw of refs) {
    const ref = raw.trim();
    if (/^\d{1,15}$/.test(ref)) {
      const n = Number(ref);
      if (n > 0) ids.add(n);
    } else if (ref) {
      usernames.add(ref.replace(/^@/, '').toLowerCase());
    }
  }
  return { ids: [...ids], usernames: [...usernames] };
}

/**
 * Reads a typed list ("@ana, 12345 @Luis") into person refs, keeping the
 * order; anything that is neither an id nor a @username goes to `invalid`.
 */
export function parsePeopleText(text: string): { refs: string[]; invalid: string[] } {
  const refs: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (!personRef.safeParse(token).success) invalid.push(token);
    else if (!refs.some((r) => r.toLowerCase() === token.toLowerCase())) refs.push(token);
  }
  return { refs, invalid };
}

/** A user as shown in admin and organiser lists (names are null if never seen). */
export const person = z.object({
  telegramId: telegramUserId,
  username: z.string().nullable(),
  firstName: z.string().nullable(),
});
export type Person = z.infer<typeof person>;

export const userRole = z.enum(['customer', 'admin']);

/** Languages the app speaks. */
export const appLanguage = z.enum(['en', 'es', 'it', 'pt']);
export type UserRole = z.infer<typeof userRole>;

export const user = z.object({
  telegramId: telegramUserId,
  firstName: z.string().min(1).max(128),
  username: z.string().max(64).nullable(),
  languageCode: z.string().max(8).nullable(),
  role: userRole,
  createdAt: isoDateTime,
});
export type User = z.infer<typeof user>;

/** Public-facing subset returned to the client after auth. */
export const sessionUser = user.pick({
  telegramId: true,
  firstName: true,
  username: true,
  languageCode: true,
  role: true,
}).extend({
  /** Effective language: the one chosen in the app, else Telegram's. */
  language: appLanguage,
  /** Language chosen in the app, or null to follow Telegram. */
  preferredLanguage: appLanguage.nullable(),
});
export type SessionUser = z.infer<typeof sessionUser>;

/** Choose the app language (null = follow Telegram again). */
export const updateLanguageRequest = z.object({ language: appLanguage.nullable() });
export type UpdateLanguageRequest = z.infer<typeof updateLanguageRequest>;
