import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>;

export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    // Drop idle connections soon: Neon closes them when it scales to zero.
    idleTimeoutMillis: 10_000,
    // Give a sleeping Neon time to wake up, but do not hang forever.
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
  // An idle connection closed by the database (Neon suspending, a network
  // blip) is reported here. Without a listener Node treats it as an unhandled
  // 'error' event and kills the whole API (Render then answers 502 until it
  // restarts). The pool simply opens a new connection on the next query.
  pool.on('error', (error) => {
    console.warn('Database connection closed:', error.message);
  });
  return pool;
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema, casing: 'snake_case' });
}
