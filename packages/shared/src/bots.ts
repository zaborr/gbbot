import { z } from 'zod';

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
  bots: BotInfo[];
  history: BotSwitchEntry[];
}

/** A bot token as @BotFather gives it: `<id>:<secret>`. */
export const BOT_TOKEN_RE = /^\d{5,}:[\w-]{30,}$/;

export const switchBotRequest = z.object({
  token: z.string().trim().regex(BOT_TOKEN_RE, 'Not a bot token'),
});
export type SwitchBotRequest = z.infer<typeof switchBotRequest>;
