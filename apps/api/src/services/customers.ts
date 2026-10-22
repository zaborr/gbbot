import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { describeWebAdmin, isWebSession } from './webAdmins.js';

/** "Ana López (@ana) · id 123" — how a customer is shown in admin messages. */
export async function describeCustomer(db: Database, telegramId: number): Promise<string> {
  if (isWebSession(telegramId)) return describeWebAdmin(db, telegramId);
  const user = await db.query.users.findFirst({ where: eq(users.telegramId, telegramId) });
  const name = user?.firstName || '—';
  return `${name}${user?.username ? ` (@${user.username})` : ''} · id ${telegramId}`;
}
