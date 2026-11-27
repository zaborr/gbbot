import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { invites, webAdmins, webKeys } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { addToPlatformBlacklist } from './blacklist.js';
import { forgetMembership } from './members.js';
import { managesSomething } from './team.js';
import { forgetSessions } from './webAdmins.js';

/**
 * Out of the platform, at once and everywhere: on the platform blacklist (for
 * them no GB exists), their web keys taken back, their web account removed
 * (every session ends) and the invitations they made taken back. Undone by
 * taking them off the platform blacklist (the account is not restored).
 */
export async function expel(
  db: Database,
  env: Env,
  by: number,
  userId: number,
  reason: string,
): Promise<{ keys: number; account: boolean; invites: number }> {
  if (await managesSomething(db, env, userId)) {
    throw ApiError.badRequest('expel_staff', 'This person manages GBs: take their roles away first');
  }
  await addToPlatformBlacklist(db, env, by, String(userId), false, reason);
  const now = new Date();
  const keys = await db
    .update(webKeys)
    .set({ revokedAt: now })
    .where(and(eq(webKeys.userId, userId), isNull(webKeys.revokedAt)))
    .returning({ id: webKeys.id });
  const account = await db.delete(webAdmins).where(eq(webAdmins.telegramId, userId)).returning({ id: webAdmins.id });
  const made = await db
    .update(invites)
    .set({ revokedAt: now })
    .where(and(eq(invites.createdBy, userId), isNull(invites.revokedAt)))
    .returning({ id: invites.id });
  forgetSessions();
  forgetMembership(userId);
  return { keys: keys.length, account: account.length > 0, invites: made.length };
}
