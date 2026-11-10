import { asc, eq } from 'drizzle-orm';
import type { BotSwitchReason, BotsOverview } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { bots, creatorAccounts } from '../db/schema.js';
import { TelegramApi, TelegramError } from '../telegram/api.js';
import { tr } from '../i18n/messages.js';
import { botToken, botUsername } from './activeBot.js';
import { settingsRow, useReserve } from './botReserve.js';
import { creatorApi, type CreatorApi } from './creator.js';
import { accountFailed, credentialsOf } from './creatorAccounts.js';
import { notifyPlatform } from './webNotices.js';

/** Failed answers in a row (one a minute) before the bot counts as closed. */
const FAILURES_TO_SWITCH = 3;

interface WatchState {
  checkedAt: Date | null;
  userCheckedAt: Date | null;
  failures: number;
  problem: string | null;
  /** The bot the problem was about (told once per bot). */
  toldAbout: number | null;
  busy: boolean;
}

const state: WatchState = { checkedAt: null, userCheckedAt: null, failures: 0, problem: null, toldAbout: null, busy: false };

/** For the panel. */
export function watchStatus(): BotsOverview['watch'] {
  return {
    checkedAt: state.checkedAt?.toISOString() ?? null,
    userCheckedAt: state.userCheckedAt?.toISOString() ?? null,
    problem: state.problem,
  };
}

/** Test hook. */
export function resetWatch(): void {
  Object.assign(state, { checkedAt: null, userCheckedAt: null, failures: 0, problem: null, toldAbout: null, busy: false });
}

interface ResolveResult {
  found: boolean;
  restricted?: boolean;
  scam?: boolean;
  fake?: boolean;
  deleted?: boolean;
  reasons?: string[];
}

/**
 * How users see the bot, asked by a creator account (preferably not the one
 * that owns it): gone, restricted, marked as scam or fake. Null when nobody
 * could ask or it looks fine.
 */
async function userView(db: Database, env: Env, api: CreatorApi, username: string): Promise<BotSwitchReason | null> {
  const active = await db.query.bots.findFirst({ where: eq(bots.status, 'active') });
  const accounts = await db.select().from(creatorAccounts).where(eq(creatorAccounts.status, 'ok')).orderBy(asc(creatorAccounts.id));
  accounts.sort((a, b) => Number(a.id === active?.accountId) - Number(b.id === active?.accountId));
  for (const row of accounts) {
    const credentials = credentialsOf(env, row);
    if (!credentials) continue;
    try {
      const seen = await api.call<ResolveResult>('/resolve', { account: credentials, username });
      if (!seen.found || seen.deleted) return 'closed';
      if (seen.restricted || seen.scam || seen.fake) {
        state.problem = [seen.scam && 'scam', seen.fake && 'fake', ...(seen.reasons ?? [])].filter(Boolean).join(', ') || 'restricted';
        return 'restricted';
      }
      return null;
    } catch (error) {
      if (!(await accountFailed(db, env, row, error))) return null; // Network or the service: next time.
    }
  }
  return null;
}

/** The bot went down: a spare takes over, or the administrators are told there is none. */
async function takeOver(db: Database, env: Env, reason: BotSwitchReason, autoSwitch: boolean): Promise<boolean> {
  const active = await db.query.bots.findFirst({ where: eq(bots.status, 'active') });
  const name = botUsername() ? `@${botUsername()}` : String(active?.id ?? '?');
  const spares = await db.select().from(bots).where(eq(bots.status, 'reserve')).orderBy(asc(bots.createdAt));
  // A spare of another account first: the one closed may be looked at as a whole.
  spares.sort((a, b) => Number(a.accountId === active?.accountId) - Number(b.accountId === active?.accountId));
  if (autoSwitch) {
    for (const spare of spares) {
      try {
        await useReserve(db, env, spare.id, null, reason);
        resetWatch();
        return true;
      } catch (error) {
        console.error(`Spare @${spare.username} could not take over:`, error);
      }
    }
  }
  if (state.toldAbout !== (active?.id ?? 0)) {
    state.toldAbout = active?.id ?? 0;
    const key = !autoSwitch ? 'bots.downManual' : spares.length === 0 ? 'bots.downNoReserve' : 'bots.downSpareFailed';
    await notifyPlatform(db, env, (lang) =>
      tr(lang, key, { bot: name, reason: tr(lang, `bots.reason.${reason}`) }),
    ).catch(() => undefined);
  }
  return false;
}

/**
 * One look at the active bot, when its time has come: the Bot API (does the
 * token still work?) every few minutes, and as users see it (through a
 * creator account) less often.
 */
export async function watchBot(
  db: Database,
  env: Env,
  now = new Date(),
  api: CreatorApi = creatorApi(env),
  telegram: TelegramApi = new TelegramApi(botToken(env)),
): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    const settings = await settingsRow(db);
    const due = (at: Date | null, minutes: number): boolean => !at || now.getTime() - at.getTime() >= minutes * 60_000 - 5_000;
    // After a failure, ask again every minute until it is clear.
    if (state.failures === 0 && !due(state.checkedAt, settings.watchMinutes)) {
      if (!due(state.userCheckedAt, settings.userCheckMinutes)) return;
    } else {
      state.checkedAt = now;
      try {
        await telegram.getMe();
        state.failures = 0;
        state.problem = null;
      } catch (error) {
        // Only "Unauthorized" means the bot is gone; anything else may be the network.
        if (error instanceof TelegramError && (error.code === 401 || error.code === 403)) {
          state.failures += 1;
          state.problem = error.message;
          if (state.failures >= FAILURES_TO_SWITCH) await takeOver(db, env, 'closed', settings.autoSwitch);
        }
        return;
      }
    }
    const username = botUsername();
    if (username && due(state.userCheckedAt, settings.userCheckMinutes)) {
      state.userCheckedAt = now;
      const reason = await userView(db, env, api, username);
      if (reason) await takeOver(db, env, reason, settings.autoSwitch);
    }
  } finally {
    state.busy = false;
  }
}

export function scheduleBotWatch(db: Database, env: Env): void {
  const run = (): void =>
    void watchBot(db, env).catch((error: unknown) => console.error('Bot watch failed:', error));
  setTimeout(run, 30_000).unref();
  setInterval(run, 60_000).unref();
}
