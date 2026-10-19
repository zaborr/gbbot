import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVipMembers } from '@tma-shop/shared';
import { TelegramApi } from '../telegram/api.js';
import {
  botIdOf,
  claimUsername,
  isGroupMember,
  isMemberStatus,
  listMatch,
  resetVipCache,
  resolveGroups,
} from './vip.js';

const club = { groups: [], userIds: [111], usernames: ['ana_vip'] };

describe('VIP club', () => {
  beforeEach(() => resetVipCache());

  it('reads pasted member lists', () => {
    expect(parseVipMembers('@Ana_Vip, 12345\nhttps://t.me/bob_x  ;  @x  -5')).toEqual({
      userIds: [12345],
      usernames: ['ana_vip', 'bob_x'],
      invalid: ['@x', '-5'],
    });
  });

  it('matches people by id or @username and keeps the id', () => {
    expect(listMatch(club, 111, null)).toBe('id');
    expect(listMatch(club, 222, 'Ana_VIP')).toBe('username');
    expect(listMatch(club, 222, 'someone')).toBeNull();
    expect(claimUsername(club, 'Ana_VIP', 222)).toEqual({
      groups: [],
      userIds: [111, 222],
      usernames: [],
    });
  });

  it('understands Telegram membership answers', () => {
    expect(isMemberStatus({ status: 'member' })).toBe(true);
    expect(isMemberStatus({ status: 'creator' })).toBe(true);
    expect(isMemberStatus({ status: 'restricted', is_member: true })).toBe(true);
    expect(isMemberStatus({ status: 'restricted', is_member: false })).toBe(false);
    expect(isMemberStatus({ status: 'left' })).toBe(false);
    expect(isMemberStatus({ status: 'kicked' })).toBe(false);
    expect(botIdOf('7654321:AAFake')).toBe(7654321);
  });

  it('asks Telegram about a group once and remembers the answer for a while', async () => {
    const telegram = new TelegramApi('1:abc');
    const ask = vi.spyOn(telegram, 'getChatMember').mockResolvedValue({ status: 'member' });
    expect(await isGroupMember(telegram, -100, 5, 0)).toBe(true);
    expect(await isGroupMember(telegram, -100, 5, 60_000)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // After six hours it asks again.
    ask.mockResolvedValue({ status: 'left' });
    expect(await isGroupMember(telegram, -100, 5, 7 * 60 * 60 * 1000)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('treats errors (bot removed, chat gone) as not a member', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const telegram = new TelegramApi('1:abc');
    vi.spyOn(telegram, 'getChatMember').mockRejectedValue(new Error('chat not found'));
    expect(await isGroupMember(telegram, -100, 5, 0)).toBe(false);
  });

  it('only accepts groups the bot is in', async () => {
    const telegram = new TelegramApi('42:abc');
    vi.spyOn(telegram, 'getChat').mockImplementation(async (ref) =>
      ref === '@club' ? { id: -1001, type: 'supergroup', title: 'Club' } : { id: -1002, type: 'channel', title: 'News' },
    );
    vi.spyOn(telegram, 'getChatMember').mockImplementation(async (chatId) =>
      chatId === -1001 ? { status: 'member' } : { status: 'left' },
    );
    expect(await resolveGroups(telegram, '42:abc', ['@club'], [])).toEqual([
      { chatId: -1001, title: 'Club' },
    ]);
    await expect(resolveGroups(telegram, '42:abc', ['-1002'], [])).rejects.toThrow(
      'The bot is not in "News"',
    );
    // Groups already saved are kept without asking Telegram again.
    expect(
      await resolveGroups(telegram, '42:abc', ['-1003'], [{ chatId: -1003, title: 'Old' }]),
    ).toEqual([{ chatId: -1003, title: 'Old' }]);
  });
});
