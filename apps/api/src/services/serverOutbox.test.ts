import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import type { TelegramApi } from '../telegram/api.js';
import { parseOutbox, sendOutbox } from './serverOutbox.js';

describe('server outbox', () => {
  it('reads who to tell, the message to edit and the text', () => {
    expect(parseOutbox('chat=42\nmessage=7\n---\n✅ Done\nline two\n')).toEqual({
      chat: 42,
      message: 7,
      text: '✅ Done\nline two',
    });
    expect(parseOutbox('chat=42\nmessage=\n---\nHi\n')).toEqual({ chat: 42, message: null, text: 'Hi' });
    expect(parseOutbox('chat=x\n---\nHi')).toBeNull();
    expect(parseOutbox('no separator')).toBeNull();
  });

  it('sends with the active bot, editing the message (or sending when it cannot), and empties the outbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gb-outbox-'));
    const env = { BOT_TOKEN: '1:abc', UPDATE_DIR: dir } as unknown as Env;
    await writeFile(join(dir, 'outbox-update-1.msg'), 'chat=42\nmessage=7\n---\n✅ Updated\n');
    await writeFile(join(dir, 'outbox-backup-2-42.msg'), 'chat=42\n---\n❌ Backup\n');
    await writeFile(join(dir, 'outbox-half.msg.tmp'), 'chat=42\n---\nnot yet\n');
    await writeFile(join(dir, 'current'), 'abc\n');
    const telegram = {
      editMessageText: vi.fn(async () => {
        throw new Error('message to edit not found');
      }),
      sendMessage: vi.fn(async () => ({})),
    } as unknown as TelegramApi;

    expect(await sendOutbox(env, telegram)).toBe(2);
    expect(telegram.editMessageText).toHaveBeenCalledWith(42, 7, '✅ Updated');
    expect(telegram.sendMessage).toHaveBeenCalledWith(42, '✅ Updated');
    expect(telegram.sendMessage).toHaveBeenCalledWith(42, '❌ Backup');
    expect((await readdir(dir)).sort()).toEqual(['current', 'outbox-half.msg.tmp']);
  });
});
