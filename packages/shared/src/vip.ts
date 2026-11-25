import { z } from 'zod';
import { telegramUserId } from './user.js';

/**
 * VIP clubs: who counts as VIP. There is one platform-wide club and one per
 * shop; a shop's VIPs are the members of its own club plus, if the shop says
 * so, the platform's. Members come from Telegram groups/channels the bot is
 * in, and from a hand-made list of @usernames and Telegram ids.
 */

/** Telegram username without the "@", lowercase. */
export const VIP_USERNAME_RE = /^[a-z][a-z0-9_]{3,31}$/;

export const vipGroup = z.object({
  /** Telegram chat id (groups and channels are negative). */
  chatId: z.number().int(),
  title: z.string().max(256),
});
export type VipGroup = z.infer<typeof vipGroup>;

export const vipClub = z.object({
  groups: z.array(vipGroup).max(20),
  userIds: z.array(telegramUserId).max(5000),
  /** Listed by @username and not seen yet; turned into ids when they open the app. */
  usernames: z.array(z.string().regex(VIP_USERNAME_RE)).max(5000),
  /**
   * The organisers' note for a member (who it is): by id ("123") or username
   * ("ana"). A username's note moves to the id when it turns into one.
   */
  notes: z.record(z.string(), z.string().max(80)).optional(),
});
export type VipClub = z.infer<typeof vipClub>;

/** A club as the organisers see it: with the names of members who opened the app (by id). */
export type VipClubWithNames<T extends VipClub = VipClub> = T & { names?: Record<string, string> };

export const EMPTY_VIP_CLUB: VipClub = { groups: [], userIds: [], usernames: [] };

/** A shop's club as its admins see it. */
export const shopVipClub = vipClub.extend({
  /** Whether members of the platform's club also count as VIPs of this shop. */
  useGlobalClub: z.boolean(),
});
export type ShopVipClub = z.infer<typeof shopVipClub>;

/** Saving a club. Groups are given as "@publicname" or a chat id like "-1001234567890". */
export const updateVipClubRequest = z.object({
  groups: z.array(z.string().trim().min(2).max(64)).max(20),
  userIds: z.array(telegramUserId).max(5000),
  usernames: z.array(z.string().regex(VIP_USERNAME_RE)).max(5000),
  /** Notes by id or username (what follows "#" on a line). */
  notes: z.record(z.string().max(40), z.string().max(80)).optional(),
  /** Shops only. */
  useGlobalClub: z.boolean().optional(),
});
export type UpdateVipClubRequest = z.infer<typeof updateVipClubRequest>;

/**
 * Splits a pasted member list ("@ana, 12345\n@Bob") into ids and usernames.
 * Anything that is neither is returned in `invalid`.
 */
export function parseVipMembers(text: string): {
  userIds: number[];
  usernames: string[];
  invalid: string[];
  /** What follows "#" on a line, for the members on it. */
  notes: Record<string, string>;
} {
  const userIds = new Set<number>();
  const usernames = new Set<string>();
  const invalid: string[] = [];
  const notes: Record<string, string> = {};
  for (const line of text.split(/\n/)) {
    const hash = line.indexOf('#');
    const note = hash >= 0 ? line.slice(hash + 1).trim().slice(0, 80) : '';
    for (const raw of (hash >= 0 ? line.slice(0, hash) : line).split(/[\s,;]+/)) {
      const token = raw.trim();
      if (!token) continue;
      if (/^\d{1,15}$/.test(token)) {
        const id = Number(token);
        if (id > 0) {
          userIds.add(id);
          if (note) notes[String(id)] = note;
        } else invalid.push(token);
        continue;
      }
      const name = token
        .replace(/^https?:\/\/t\.me\//i, '')
        .replace(/^@/, '')
        .toLowerCase();
      if (VIP_USERNAME_RE.test(name)) {
        usernames.add(name);
        if (note) notes[name] = note;
      } else invalid.push(token);
    }
  }
  return { userIds: [...userIds], usernames: [...usernames], invalid, notes };
}

export function formatVipMembers(
  club: Pick<VipClub, 'userIds' | 'usernames' | 'notes'>,
  /** Names of members who opened the app, by id: the note when there is none. */
  names: Record<string, string> = {},
): string {
  const line = (member: string, key: string): string => {
    const note = club.notes?.[key] ?? names[key];
    return note ? `${member}  # ${note}` : member;
  };
  return [
    ...club.userIds.map((id) => line(String(id), String(id))),
    ...club.usernames.map((u) => line(`@${u}`, u)),
  ].join('\n');
}
