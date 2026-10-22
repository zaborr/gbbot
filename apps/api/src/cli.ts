/**
 * Server-side commands, run inside the API container:
 *
 *   docker compose exec api node dist/cli.js web-admin add <username>
 *   docker compose exec api node dist/cli.js web-admin reset <username>
 *   docker compose exec api node dist/cli.js web-admin remove <username>
 *   docker compose exec api node dist/cli.js web-admin list
 *
 * "add" and "reset" print a new password and the authenticator secret once.
 */
import { createDb, createPool } from './db/client.js';
import {
  createWebAdmin,
  listWebAdmins,
  removeWebAdmin,
  resetWebAdmin,
  type NewCredentials,
} from './services/webAdmins.js';

const USAGE = `Usage:
  node dist/cli.js web-admin add <username>     new web admin
  node dist/cli.js web-admin reset <username>   new password and authenticator (ends its sessions)
  node dist/cli.js web-admin remove <username>  delete it
  node dist/cli.js web-admin list               who exists`;

function show(credentials: NewCredentials): void {
  console.log(`
Username:  ${credentials.username}
Password:  ${credentials.password}

Authenticator app (Aegis, Google Authenticator, 2FAS…): add an account
by typing this secret (time-based, 6 digits, 30 seconds):

  ${credentials.totpSecret}

or open this link on the phone that has the app:

  ${credentials.otpauth}

They are shown only now: write them down somewhere safe.`);
}

async function main(): Promise<number> {
  const [group, action, name] = process.argv.slice(2);
  if (group !== 'web-admin' || !action) {
    console.log(USAGE);
    return 1;
  }
  const pool = createPool(process.env.DATABASE_URL ?? 'postgres://tma:tma@localhost:5432/tma_shop');
  const db = createDb(pool);
  try {
    switch (action) {
      case 'add':
        if (!name) break;
        show(await createWebAdmin(db, name));
        return 0;
      case 'reset':
        if (!name) break;
        show(await resetWebAdmin(db, name));
        return 0;
      case 'remove':
        if (!name) break;
        await removeWebAdmin(db, name);
        console.log(`"${name}" deleted; its sessions are closed.`);
        return 0;
      case 'list': {
        const rows = await listWebAdmins(db);
        if (rows.length === 0) console.log('No web admins yet.');
        for (const row of rows) {
          const last = row.lastLoginAt ? row.lastLoginAt.toISOString() : 'never';
          const locked = row.lockedUntil && row.lockedUntil > new Date() ? ' (locked)' : '';
          console.log(`${row.username}  last sign-in: ${last}${locked}`);
        }
        return 0;
      }
    }
    console.log(USAGE);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await pool.end();
  }
}

main().then((code) => process.exit(code));
