import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from '../config/env.js';
import { TelegramApi } from '../telegram/api.js';
import { botToken } from './activeBot.js';
import { UPDATE_DIR_DEFAULT } from './serverUpdate.js';

/**
 * Messages the server's own scripts (the update, the off-site backup) leave
 * for the bot to send: they cannot know which bot is active (it lives in the
 * database, and BOT_TOKEN in .env may be an old one), so the API sends them.
 *
 * One file per message in the shared folder, `outbox-<anything>.msg`:
 *   chat=123          who to tell
 *   message=456       optional: edit that message of the bot instead
 *   button=srv:x|Text optional: one button under it (only /server's own)
 *   ---
 *   the text (any number of lines)
 */
const OUTBOX = /^outbox-[\w.-]+\.msg$/;

export interface OutboxMessage {
  chat: number;
  message: number | null;
  text: string;
  button: { data: string; text: string } | null;
}

/** Reads one outbox file; null when it is not one. */
export function parseOutbox(content: string): OutboxMessage | null {
  const split = content.indexOf('\n---\n');
  if (split < 0) return null;
  const head = new Map(
    content
      .slice(0, split)
      .split('\n')
      .map((line) => line.split('=', 2) as [string, string | undefined])
      .filter((pair): pair is [string, string] => pair[1] !== undefined)
      .map(([k, v]) => [k.trim(), v.trim()]),
  );
  const chat = Number(head.get('chat'));
  const message = head.get('message') ? Number(head.get('message')) : null;
  const text = content.slice(split + 5).trim();
  if (!Number.isSafeInteger(chat) || chat === 0 || !text) return null;
  // Only the buttons of /server (the server's scripts cannot make others).
  const pressed = /^(srv:[a-z]+!?)\|(.{1,64})$/.exec(head.get('button') ?? '');
  return {
    chat,
    message: message !== null && Number.isSafeInteger(message) && message > 0 ? message : null,
    text,
    button: pressed ? { data: pressed[1] as string, text: pressed[2] as string } : null,
  };
}

/** Sends what is waiting in the outbox (and removes it), through the active bot. */
export async function sendOutbox(env: Env, telegram?: TelegramApi): Promise<number> {
  const dir = env.UPDATE_DIR ?? UPDATE_DIR_DEFAULT;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => OUTBOX.test(name)).sort();
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  const api = telegram ?? new TelegramApi(botToken(env));
  let sent = 0;
  for (const name of names) {
    const path = join(dir, name);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const msg = parseOutbox(content);
    // Taken first, so two runs never send it twice.
    await rm(path, { force: true });
    if (!msg) continue;
    const text = msg.text.slice(0, 4000);
    const keyboard = msg.button
      ? { inline_keyboard: [[{ text: msg.button.text, callback_data: msg.button.data }]] }
      : undefined;
    try {
      if (msg.message !== null) {
        try {
          await api.editMessageText(msg.chat, msg.message, text, keyboard);
        } catch {
          await api.sendMessage(msg.chat, text, keyboard);
        }
      } else {
        await api.sendMessage(msg.chat, text, keyboard);
      }
      sent += 1;
    } catch (error) {
      console.error('Could not send a message from the server:', error);
    }
  }
  return sent;
}

/** Every few seconds (and now): the API may have just been restarted by an update. */
export function scheduleOutbox(env: Env): void {
  const run = (): void => {
    sendOutbox(env).catch((error: unknown) => console.error('Server outbox failed:', error));
  };
  run();
  setInterval(run, 10 * 1000).unref();
}
