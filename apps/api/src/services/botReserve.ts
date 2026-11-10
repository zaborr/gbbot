import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { LANGS, type BotInfo, type BotSettings, type BotSwitchReason, type Lang, type UpdateBotSettingsRequest } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { botSettings, bots, creatorAccounts } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { open, seal, secretKey } from '../lib/secretBox.js';
import { TelegramApi, type BotCommand } from '../telegram/api.js';
import { tr } from '../i18n/messages.js';
import { botToken } from './activeBot.js';
import { switchBot, toInfo } from './botSwitch.js';
import { CreatorError, creatorApi, type CreatorApi, type CreatorCredentials } from './creator.js';
import { accountFailed, credentialsOf } from './creatorAccounts.js';
import { notifyPlatform } from './webNotices.js';

type SettingsRow = typeof botSettings.$inferSelect;
type BotRow = typeof bots.$inferSelect;

/** Bots per Telegram account, as @BotFather allows. */
const BOTS_PER_ACCOUNT = 20;
const CHECK_EVERY_MS = 60 * 60 * 1000;

export async function settingsRow(db: Database): Promise<SettingsRow> {
  const row = await db.query.botSettings.findFirst();
  if (row) return row;
  const [created] = await db.insert(botSettings).values({ id: 1 }).onConflictDoNothing().returning();
  return created ?? (await db.query.botSettings.findFirst())!;
}

const toSettings = (row: SettingsRow): BotSettings => ({
  usernamePrefix: row.usernamePrefix,
  name: row.name,
  descriptions: row.descriptions,
  shortDescriptions: row.shortDescriptions,
  photo: row.photo,
  reserveCount: row.reserveCount,
  reserveEveryDays: row.reserveEveryDays,
  watchMinutes: row.watchMinutes,
  userCheckMinutes: row.userCheckMinutes,
  autoSwitch: row.autoSwitch,
  lastError: row.lastError,
  lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
});

export async function getBotSettings(db: Database): Promise<BotSettings> {
  return toSettings(await settingsRow(db));
}

async function noteError(db: Database, message: string | null): Promise<void> {
  await db
    .update(botSettings)
    .set({ lastError: message, lastErrorAt: message ? new Date() : null })
    .where(eq(botSettings.id, 1));
}

/** Saves how the bots look; it is then put on the active bot and the spares. */
export async function updateBotSettings(
  db: Database,
  env: Env,
  input: UpdateBotSettingsRequest,
  api: CreatorApi = creatorApi(env),
): Promise<BotSettings> {
  await settingsRow(db);
  const [row] = await db
    .update(botSettings)
    .set({
      usernamePrefix: input.usernamePrefix,
      name: input.name,
      descriptions: input.descriptions,
      shortDescriptions: input.shortDescriptions,
      ...(input.photo !== undefined ? { photo: input.photo } : {}),
      reserveCount: input.reserveCount,
      reserveEveryDays: input.reserveEveryDays,
      watchMinutes: input.watchMinutes,
      userCheckMinutes: input.userCheckMinutes,
      autoSwitch: input.autoSwitch,
      updatedAt: new Date(),
    })
    .where(eq(botSettings.id, 1))
    .returning();
  // Telegram and @BotFather take a while: done in the background.
  void applyAppearance(db, env, api, input.photo !== undefined).catch((error: unknown) =>
    console.error('Could not apply the bot appearance:', error),
  );
  return toSettings(row!);
}

/** Name and descriptions for a language ('' = the default one, in English). */
function profileFor(settings: SettingsRow, lang: Lang | '', fallbackName: string): {
  name: string;
  description: string;
  shortDescription: string;
} {
  const key: Lang = lang || 'en';
  return {
    name: settings.name || fallbackName,
    description: settings.descriptions[key] ?? settings.descriptions.en ?? '',
    shortDescription: settings.shortDescriptions[key] ?? settings.shortDescriptions.en ?? '',
  };
}

/** Name, descriptions and commands (the active bot's) on a bot, through the Bot API. */
async function putProfile(
  settings: SettingsRow,
  bot: TelegramApi,
  active: TelegramApi | null,
  fallbackName: string,
): Promise<void> {
  for (const lang of ['', ...LANGS] as const) {
    await bot.setProfile(lang, profileFor(settings, lang, fallbackName));
    if (!active) continue;
    const commands: BotCommand[] = await active.getMyCommands(lang).catch(() => []);
    if (commands.length > 0) await bot.setMyCommands(lang, commands);
  }
}

function tokenOf(env: Env, row: BotRow): string | null {
  return open(secretKey(env), row.token);
}

async function accountCredentials(db: Database, env: Env, accountId: number | null): Promise<Owner | null> {
  if (accountId === null) return null;
  const row = await db.query.creatorAccounts.findFirst({ where: eq(creatorAccounts.id, accountId) });
  const credentials = row && row.status === 'ok' ? credentialsOf(env, row) : null;
  return row && credentials ? { row, credentials } : null;
}

/** Puts the photo on a bot, through the account that made it. */
async function putPhoto(
  db: Database,
  env: Env,
  api: CreatorApi,
  bot: BotRow,
  photo: string,
): Promise<void> {
  const owner = await accountCredentials(db, env, bot.accountId);
  if (!owner || !bot.username) return;
  try {
    await api.call('/botfather/setuserpic', { account: owner.credentials, username: bot.username, photo });
  } catch (error) {
    await accountFailed(db, env, owner.row, error);
    throw error;
  }
}

/**
 * Puts the name, descriptions (and the photo, when it changed) on the active
 * bot and the spares. Problems are kept to show them in the panel.
 */
export async function applyAppearance(
  db: Database,
  env: Env,
  api: CreatorApi = creatorApi(env),
  withPhoto = true,
  telegramFor: (token: string) => TelegramApi = (t) => new TelegramApi(t),
): Promise<void> {
  const settings = await settingsRow(db);
  const rows = await db.select().from(bots).where(inArray(bots.status, ['active', 'reserve']));
  const active = telegramFor(botToken(env));
  const fallback = (await active.getProfile('').catch(() => null))?.name ?? 'GB';
  const problems: string[] = [];
  for (const row of rows) {
    const token = tokenOf(env, row);
    if (!token) continue;
    try {
      await putProfile(settings, telegramFor(token), row.status === 'active' ? null : active, fallback);
      if (withPhoto && settings.photo) await putPhoto(db, env, api, row, settings.photo);
      await db.update(bots).set({ appearanceAt: new Date() }).where(eq(bots.id, row.id));
    } catch (error) {
      problems.push(`@${row.username ?? row.id}: ${error instanceof CreatorError ? error.reason : error instanceof Error ? error.message : error}`);
    }
  }
  await noteError(db, problems.length > 0 ? problems.join(' · ') : null);
}

const randomPart = (): string => randomBytes(3).toString('hex').slice(0, 4);

type Owner = { row: typeof creatorAccounts.$inferSelect; credentials: CreatorCredentials };

/** The account with fewest bots (not the active bot's, if there is a choice). */
async function pickAccount(db: Database, env: Env): Promise<Owner> {
  const accounts = await db
    .select()
    .from(creatorAccounts)
    .where(eq(creatorAccounts.status, 'ok'))
    .orderBy(asc(creatorAccounts.id));
  const owned = await db
    .select({ accountId: bots.accountId, status: bots.status })
    .from(bots)
    .where(isNotNull(bots.accountId));
  const activeAccount = owned.find((b) => b.status === 'active')?.accountId ?? null;
  const usable: Array<Owner & { count: number; holdsActive: boolean }> = [];
  for (const row of accounts) {
    const credentials = credentialsOf(env, row);
    const count = owned.filter((b) => b.accountId === row.id).length;
    if (credentials && count < BOTS_PER_ACCOUNT) {
      usable.push({ row, credentials, count, holdsActive: row.id === activeAccount });
    }
  }
  usable.sort((a, b) => Number(a.holdsActive) - Number(b.holdsActive) || a.count - b.count);
  const best = usable[0];
  if (!best) throw ApiError.conflict('no_creator', 'No creator account can create bots: add one or sign it in again');
  return best;
}

/** A refusal while creating a bot, as the panel shows it. */
function creationError(error: unknown): unknown {
  if (!(error instanceof CreatorError)) return error;
  if (error.reason === 'FLOOD_WAIT') {
    return ApiError.conflict('botfather_wait', `@BotFather asks to wait ${error.seconds ?? '?'} seconds`);
  }
  if (error.reason === 'TOO_MANY_BOTS') return ApiError.conflict('botfather_full', 'That account already has 20 bots');
  return ApiError.conflict('botfather_error', `@BotFather did not create it (${error.reason})`);
}

/**
 * A new spare: @BotFather creates it with one of the creator accounts, then it
 * gets the name, descriptions, commands, the Mini App button and the photo.
 * It has no webhook until it takes over.
 */
export async function createReserve(
  db: Database,
  env: Env,
  api: CreatorApi = creatorApi(env),
  telegramFor: (token: string) => TelegramApi = (t) => new TelegramApi(t),
): Promise<BotInfo> {
  const settings = await settingsRow(db);
  const account = await pickAccount(db, env);
  const active = telegramFor(botToken(env));
  const fallback = (await active.getProfile('').catch(() => null))?.name ?? 'GB';

  let token: string | null = null;
  let username = '';
  for (let attempt = 0; attempt < 3 && !token; attempt++) {
    username = `${settings.usernamePrefix}_${randomPart()}_bot`.toLowerCase();
    try {
      ({ token } = await api.call<{ token: string }>('/botfather/newbot', {
        account: account.credentials,
        name: settings.name || fallback,
        username,
      }));
    } catch (error) {
      if (error instanceof CreatorError && error.reason === 'USERNAME_TAKEN') continue;
      if (await accountFailed(db, env, account.row, error)) {
        throw ApiError.conflict('creator_session', 'The creator account has to sign in again');
      }
      throw creationError(error);
    }
  }
  if (!token) throw ApiError.conflict('botfather_names', 'No free @ found: change the prefix');

  const bot = telegramFor(token);
  const me = await bot.getMe();
  const problems: string[] = [];
  try {
    await putProfile(settings, bot, active, fallback);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  // The Mini App button, as the active bot has it.
  const button = await active.getChatMenuButton().catch(() => null);
  const base = env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL;
  const url = button?.type === 'web_app' ? button.web_app?.url : base ? `${base.replace(/\/+$/, '')}/` : undefined;
  if (url) await bot.setChatMenuButton(button?.text ?? tr('en', 'start.button'), url).catch((e: unknown) => problems.push(String(e)));

  const [row] = await db
    .insert(bots)
    .values({
      id: me.id,
      username: me.username ?? username,
      token: seal(secretKey(env), token),
      status: 'reserve',
      accountId: account.row.id,
      appearanceAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (settings.photo && row) {
    await putPhoto(db, env, api, row, settings.photo).catch((error: unknown) =>
      problems.push(`photo: ${error instanceof CreatorError ? error.reason : String(error)}`),
    );
  }
  await noteError(db, problems.length > 0 ? `@${me.username}: ${problems.join(' · ')}` : null);
  return toInfo(row!);
}

/** A spare takes over now. */
export async function useReserve(
  db: Database,
  env: Env,
  botId: number,
  byUser: number | null,
  reason: BotSwitchReason = 'manual',
): Promise<BotInfo> {
  const row = await db.query.bots.findFirst({ where: and(eq(bots.id, botId), eq(bots.status, 'reserve')) });
  if (!row) throw ApiError.notFound('Spare bot not found');
  const token = tokenOf(env, row);
  if (!token) throw ApiError.conflict('bot_key', 'The bot token cannot be read');
  return switchBot(db, env, token, reason, byUser, undefined, { fromReserve: true });
}

/** Takes a spare out (and deletes it in @BotFather when an account of ours made it). */
export async function retireBot(db: Database, env: Env, botId: number, api: CreatorApi = creatorApi(env)): Promise<void> {
  const row = await db.query.bots.findFirst({ where: and(eq(bots.id, botId), ne(bots.status, 'active')) });
  if (!row) throw ApiError.notFound('Bot not found');
  const owner = await accountCredentials(db, env, row.accountId);
  if (owner && row.username) {
    try {
      await api.call('/botfather/deletebot', { account: owner.credentials, username: row.username });
    } catch (error) {
      if (await accountFailed(db, env, owner.row, error)) {
        throw ApiError.conflict('creator_session', 'The creator account has to sign in again');
      }
      throw creationError(error);
    }
  }
  await db.delete(bots).where(eq(bots.id, row.id));
}

/**
 * Keeps the spares: when there are fewer than wanted and the last one was made
 * long enough ago, one more is created. Slowly on purpose.
 */
export async function keepReserve(
  db: Database,
  env: Env,
  api: CreatorApi = creatorApi(env),
  now = new Date(),
  telegramFor?: (token: string) => TelegramApi,
): Promise<BotInfo | null> {
  const settings = await settingsRow(db);
  const rows = await db.select().from(bots);
  const spares = rows.filter((row) => row.status === 'reserve').length;
  if (spares >= settings.reserveCount) return null;
  const last = Math.max(0, ...rows.filter((row) => row.accountId !== null).map((row) => row.createdAt.getTime()));
  if (now.getTime() - last < settings.reserveEveryDays * 24 * 60 * 60 * 1000) return null;
  try {
    return await createReserve(db, env, api, telegramFor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (settings.lastError !== message) {
      await notifyPlatform(db, env, (lang) => tr(lang, 'bots.reserveFailed', { error: message })).catch(() => undefined);
    }
    await noteError(db, message);
    return null;
  }
}

export function scheduleReserve(db: Database, env: Env): void {
  const run = (): void =>
    void keepReserve(db, env).catch((error: unknown) => console.error('Spare bots check failed:', error));
  setTimeout(run, 5 * 60_000).unref();
  setInterval(run, CHECK_EVERY_MS).unref();
}
