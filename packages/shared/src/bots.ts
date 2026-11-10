import { z } from 'zod';
import { LANGS, type Lang } from './i18n.js';

/** A bot of the platform: the one answering, a spare, or one Telegram closed. */
export type BotStatus = 'active' | 'reserve' | 'down';

/**
 * Why another bot took over: changed from the panel, Telegram closed or
 * restricted the bot, or a new token was put in .env by hand.
 */
export type BotSwitchReason = 'manual' | 'closed' | 'restricted' | 'env';

export interface BotInfo {
  id: number;
  username: string | null;
  status: BotStatus;
  createdAt: string;
  activatedAt: string | null;
  downAt: string | null;
  downReason: string | null;
  /** The creator account that made it (null: created by hand). */
  accountId: number | null;
}

export interface BotSwitchEntry {
  id: number;
  at: string;
  from: { id: number; username: string | null } | null;
  to: { id: number; username: string | null };
  reason: BotSwitchReason;
}

export interface BotsOverview {
  active: BotInfo | null;
  /** Whether Telegram still answers as the active bot (checked just now). */
  working: boolean;
  /** Where the active bot's Mini App button opens (null: it has none). */
  menuUrl: string | null;
  bots: BotInfo[];
  history: BotSwitchEntry[];
}

/** A bot token as @BotFather gives it: `<id>:<secret>`. */
export const BOT_TOKEN_RE = /^\d{5,}:[\w-]{30,}$/;

export const switchBotRequest = z.object({
  token: z.string().trim().regex(BOT_TOKEN_RE, 'Not a bot token'),
});
export type SwitchBotRequest = z.infer<typeof switchBotRequest>;

/**
 * A creator account: a Telegram user account the server acts as to create
 * bots in @BotFather, post to the notices channel and add the bot to groups.
 * `login`: signing in is not finished (or Telegram asks for the code again);
 * `closed`: Telegram closed the account.
 */
export type CreatorAccountStatus = 'login' | 'ok' | 'closed';

export interface CreatorAccountInfo {
  id: number;
  /** Only the last digits. */
  phone: string;
  status: CreatorAccountStatus;
  telegramId: number | null;
  username: string | null;
  firstName: string | null;
  createdAt: string;
  checkedAt: string | null;
  lastError: string | null;
}

export const addCreatorAccountRequest = z.object({
  phone: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s()-]/g, ''))
    .pipe(z.string().regex(/^\+\d{7,15}$/, 'Phone number with country code, e.g. +34600000000')),
  apiId: z.coerce.number().int().positive(),
  apiHash: z.string().trim().regex(/^[0-9a-f]{32}$/i, 'api_hash: 32 letters and numbers from my.telegram.org'),
});
export type AddCreatorAccountRequest = z.infer<typeof addCreatorAccountRequest>;

export const creatorCodeRequest = z.object({ code: z.string().trim().regex(/^\d{4,8}$/, 'The code has only numbers') });
export const creatorPasswordRequest = z.object({ password: z.string().min(1) });

/** Where signing in is: waiting for the code, for the password, or done. */
export interface CreatorLoginStep {
  id: number;
  step: 'code' | 'password' | 'done';
  /** The code went to the account's Telegram app (not by SMS). */
  viaApp?: boolean;
  /** The two-step password hint, if any. */
  hint?: string | null;
}

/** How the bots look and how many spares are kept ready. */
export interface BotSettings {
  /** The @ of new bots: `<prefix>_<random>_bot`. */
  usernamePrefix: string;
  /** Visible name (empty: the active bot's). */
  name: string;
  descriptions: Partial<Record<Lang, string>>;
  shortDescriptions: Partial<Record<Lang, string>>;
  /** Profile photo, base64 (null: none). */
  photo: string | null;
  reserveCount: number;
  /** At least this many days between two new spares. */
  reserveEveryDays: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

const perLang = (max: number) =>
  z.partialRecord(z.enum(LANGS), z.string().trim().max(max));

export const updateBotSettingsRequest = z.object({
  usernamePrefix: z
    .string()
    .trim()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{2,20}$/, 'Prefix: 3 to 21 letters, numbers or "_", starting with a letter'),
  name: z.string().trim().max(64),
  descriptions: perLang(512),
  shortDescriptions: perLang(120),
  /** New photo (base64), null to remove it, absent to keep it. */
  photo: z.string().max(1_500_000).nullable().optional(),
  reserveCount: z.number().int().min(0).max(5),
  reserveEveryDays: z.number().int().min(1).max(30),
});
export type UpdateBotSettingsRequest = z.infer<typeof updateBotSettingsRequest>;
