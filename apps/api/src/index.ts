import { serve } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { createDb, createPool } from './db/client.js';
import { createApp } from './app.js';
import { configureBot } from './services/bot.js';
import { loadActiveBot } from './services/activeBot.js';
import { scheduleMaintenance } from './services/maintenance.js';
import { scheduleDrawWatcher } from './services/testingDraw.js';
import { resumePaymentChecks } from './services/paymentCheck.js';

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

// Every 3 hours (and now): cancel unpaid orders past their deadline, then
// delete personal data past its retention period. One run, one database wake-up.
scheduleMaintenance(db, env);
scheduleDrawWatcher(db, env);

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
