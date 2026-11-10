import { asc, desc, eq } from 'drizzle-orm';
import type { BotGroupStatus, BotSwitchNotices, BotSwitchReason, VipGroup } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { botSettings, botSwitches, creatorAccounts, platformSettings, shops } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { CreatorError, creatorApi, type CreatorApi, type CreatorCredentials } from './creator.js';
import { accountFailed, credentialsOf } from './creatorAccounts.js';
import { languagesOf } from './notifications.js';

/** Every guests/VIP group the bot checks members of (GBs and the platform), once each. */
export async function allGroups(db: Database): Promise<VipGroup[]> {
  const found = new Map<number, VipGroup>();
  const add = (groups: VipGroup[] | undefined): void => {
    for (const group of groups ?? []) if (!found.has(group.chatId)) found.set(group.chatId, group);
  };
  for (const shop of await db.select({ vip: shops.vipClub, guests: shops.guestList }).from(shops)) {
    add(shop.vip.groups);
    add(shop.guests.groups);
  }
  for (const row of await db.select({ vip: platformSettings.vipClub, guests: platformSettings.guestList }).from(platformSettings)) {
    add(row.vip.groups);
    add(row.guests.groups);
  }
  return [...found.values()];
}

type Account = { row: typeof creatorAccounts.$inferSelect; credentials: CreatorCredentials };

async function signedInAccounts(db: Database, env: Env): Promise<Account[]> {
  const rows = await db.select().from(creatorAccounts).where(eq(creatorAccounts.status, 'ok')).orderBy(asc(creatorAccounts.id));
  return rows.flatMap((row) => {
    const credentials = credentialsOf(env, row);
    return credentials ? [{ row, credentials }] : [];
  });
}

/** Tries the accounts in turn until one can do it. */
async function withSomeAccount<T>(
  db: Database,
  env: Env,
  accounts: Account[],
  run: (account: Account) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let last = 'NO_CREATOR_ACCOUNT';
  for (const account of accounts) {
    try {
      return { ok: true, value: await run(account) };
    } catch (error) {
      await accountFailed(db, env, account.row, error);
      last = error instanceof CreatorError ? error.reason : error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: last };
}

/**
 * Puts the bot in every guests/VIP group (so it can check who is in them).
 * The result per group is kept for the panel.
 */
export async function addBotToGroups(
  db: Database,
  env: Env,
  bot: string,
  api: CreatorApi = creatorApi(env),
): Promise<{ ok: number; failed: number }> {
  const groups = await allGroups(db);
  const accounts = await signedInAccounts(db, env);
  const status: Record<string, BotGroupStatus> = {};
  let ok = 0;
  for (const group of groups) {
    const result = await withSomeAccount(db, env, accounts, (account) =>
      api.call('/group/addbot', { account: account.credentials, chatId: group.chatId, bot: `@${bot}` }),
    );
    status[String(group.chatId)] = {
      title: group.title,
      ok: result.ok,
      at: new Date().toISOString(),
      ...(result.ok ? {} : { error: result.error }),
    };
    if (result.ok) ok += 1;
  }
  await db.update(botSettings).set({ groupStatus: status }).where(eq(botSettings.id, 1));
  return { ok, failed: groups.length - ok };
}

/**
 * Everything that is said when another bot takes over: privately to the
 * platform administrators, in the notices channel, and the bot goes into the
 * guests/VIP groups. Best effort; what happened is kept with the switch.
 */
export async function announceSwitch(
  db: Database,
  env: Env,
  bot: string,
  reason: BotSwitchReason,
  api: CreatorApi = creatorApi(env),
): Promise<BotSwitchNotices> {
  const settings = await db.query.botSettings.findFirst();
  const accounts = await signedInAccounts(db, env);
  const notices: BotSwitchNotices = { admins: { sent: 0, failed: 0 }, channel: null, groups: { ok: 0, failed: 0 } };

  if (settings?.dmAdmins ?? true) {
    const langs = await languagesOf(db, [...env.ADMIN_TELEGRAM_IDS]);
    for (const admin of env.ADMIN_TELEGRAM_IDS) {
      const lang = langs.get(admin) ?? 'en';
      const text = tr(lang, 'bots.switched', { bot: `@${bot}`, reason: tr(lang, `bots.reason.${reason}`) });
      const result = await withSomeAccount(db, env, accounts, (account) =>
        api.call('/dm', { account: account.credentials, to: admin, text }),
      );
      if (result.ok) notices.admins.sent += 1;
      else notices.admins.failed += 1;
    }
  }

  if (settings?.noticesChannel) {
    const text = (settings.noticeText || tr('en', 'bots.channelNotice')).replaceAll('{bot}', `@${bot}`);
    const result = await withSomeAccount(db, env, accounts, (account) =>
      api.call<{ botAdmin: boolean }>('/channel/announce', {
        account: account.credentials,
        channel: settings.noticesChannel,
        text,
        bot: `@${bot}`,
      }),
    );
    notices.channel = result.ok ? { ok: true, botAdmin: result.value.botAdmin } : { ok: false, error: result.error };
  }

  if (settings) notices.groups = await addBotToGroups(db, env, bot, api);

  const [last] = await db.select({ id: botSwitches.id }).from(botSwitches).orderBy(desc(botSwitches.at)).limit(1);
  if (last) await db.update(botSwitches).set({ notices }).where(eq(botSwitches.id, last.id));
  return notices;
}
