import { loadSupervisors } from './services/team.js';
import { serve } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { createDb, createPool } from './db/client.js';
import { createApp } from './app.js';
import { configureBot } from './services/bot.js';
import { loadActiveBot } from './services/activeBot.js';
import { scheduleCreatorChecks } from './services/creatorAccounts.js';
import { scheduleReserve } from './services/botReserve.js';
import { scheduleBotWatch } from './services/botWatch.js';
import { scheduleMaintenance } from './services/maintenance.js';
import { scheduleDrawWatcher } from './services/testingDraw.js';
import { resumePaymentChecks } from './services/paymentCheck.js';
import { scheduleOutbox } from './services/serverOutbox.js';
import { scheduleServerWarnings } from './services/serverTasks.js';
import { scheduleTestingDigests } from './services/testingDigest.js';

// A stray failed background task must not take the whole API down.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);
const db = createDb(pool);
const app = createApp({ env, db });

// The bot to answer as (stored in the database; BOT_TOKEN the first time),
// then its webhook (so it answers /start).
await loadActiveBot(db, env).catch((error: unknown) => {
  console.error('Could not load the active bot, using BOT_TOKEN:', error);
});
void configureBot(env);
// Who supervises every GB (kept in memory for the permission checks).
await loadSupervisors(db).catch((error: unknown) => {
  console.error('Could not load the supervisors:', error);
});

// Every 3 hours (and now): cancel unpaid orders past their deadline, then
// delete personal data past its retention period. One run, one database wake-up.
scheduleMaintenance(db, env);
scheduleDrawWatcher(db, env);
// Every few hours: do the creator accounts still work?
scheduleCreatorChecks(db, env);
// Every hour: keep the spare bots (slowly: at most one every few days).
scheduleReserve(db, env);
// Every minute: is it time to look at the active bot? (A spare takes over if it is gone.)
scheduleBotWatch(db, env);

// What the server's scripts (update, off-site backup) left for the bot to send.
scheduleOutbox(env);
// Every 15 minutes: does the server need its administrators (disk, backups, updates)?
scheduleServerWarnings(db, env);
// Every morning: what each GB's testings need from its team.
scheduleTestingDigests(db, env);

// Payment checks that were running before a restart.
resumePaymentChecks(db, env).catch((error: unknown) => {
  console.error('Could not resume payment checks:', error);
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`tma-shop API listening on http://localhost:${info.port}`);
});

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down…`);
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
