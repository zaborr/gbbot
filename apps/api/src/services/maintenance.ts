import type { Env } from '../config/env.js';
import { deleteExpiredUploads } from './uploads.js';
import { closeStaleBroadcasts } from './broadcast.js';
import { deleteExpiredMessages } from './expiringMessages.js';
import type { Database } from '../db/client.js';
import { cancelExpiredOrders } from './autoCancel.js';
import { runRetention } from './retention.js';
import { sendPaymentReminders } from './reminders.js';
import { closeDueShops } from './closing.js';

/** Hours between maintenance runs. Fewer runs keep the database asleep longer (Neon). */
export const MAINTENANCE_EVERY_HOURS = 3;

/**
 * Background housekeeping, all in one go so the database wakes up once:
 * closes GBs whose closing time has passed (and cleans up closed ones),
 * cancels unpaid orders past their shop's deadline, reminds customers of
 * orders still to pay, then applies the data retention policy.
 */
export async function runMaintenance(db: Database, env: Env): Promise<void> {
  try {
    const closed = await closeDueShops(db, env);
    if (closed > 0) console.log(`Closed ${closed} GB(s) on schedule.`);
  } catch (error) {
    console.error('Closing GBs failed:', error);
  }
  try {
    const cancelled = await cancelExpiredOrders(db, env);
    if (cancelled > 0) console.log(`Auto-cancelled ${cancelled} unpaid order(s).`);
  } catch (error) {
    console.error('Auto-cancel failed:', error);
  }
  try {
    const reminded = await sendPaymentReminders(db, env);
    if (reminded > 0) console.log(`Sent ${reminded} payment reminder(s).`);
  } catch (error) {
    console.error('Payment reminders failed:', error);
  }
  try {
    const deleted = await deleteExpiredMessages(db, env);
    if (deleted > 0) console.log(`Deleted ${deleted} expired bot message(s).`);
  } catch (error) {
    console.error('Deleting expired bot messages failed:', error);
  }
  try {
    await closeStaleBroadcasts(db);
  } catch (error) {
    console.error('Closing stale broadcasts failed:', error);
  }
  try {
    const dropped = await deleteExpiredUploads(db);
    if (dropped > 0) console.log(`Deleted ${dropped} expired file(s) sent to the bot.`);
  } catch (error) {
    console.error('Cleaning files sent to the bot failed:', error);
  }
  try {
    const report = await runRetention(db);
    const total = report.ordersAnonymized + report.cartsDeleted + report.usersDeleted;
    if (total > 0) console.log('Data retention:', report);
  } catch (error) {
    console.error('Data retention failed:', error);
  }
}

/** Runs the maintenance now and every few hours while the server is up. */
export function scheduleMaintenance(db: Database, env: Env): void {
  const run = (): void => void runMaintenance(db, env);
  run();
  setInterval(run, MAINTENANCE_EVERY_HOURS * 60 * 60 * 1000).unref();
}
