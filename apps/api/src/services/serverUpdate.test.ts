import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import { TelegramApi } from '../telegram/api.js';
import { changeLine, checkForUpdate, handleUpdateButton, isUpdateCommand, updateReply } from './serverUpdate.js';

const CURRENT = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

let env: Env;
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-update-'));
  env = { BOT_TOKEN: '1:abc', ADMIN_TELEGRAM_IDS: [42], UPDATE_DIR: dir } as unknown as Env;
});

const configure = async (): Promise<void> => {
  await writeFile(join(env.UPDATE_DIR as string, 'repo'), 'owner/gb\n');
  await writeFile(join(env.UPDATE_DIR as string, 'current'), `${CURRENT}\n`);
};

/** GitHub answering as if `main` had one merged pull request on top of what runs. */
function fakeGithub(run: { status: string; conclusion: string | null }): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    const body = path.endsWith('/repos/owner/gb')
      ? { default_branch: 'main' }
      : path.includes('/compare/')
        ? {
            status: 'ahead',
            commits: [
              { sha: 'c'.repeat(40), commit: { message: 'Guests: lists' } },
              { sha: NEXT, commit: { message: 'Merge pull request #34 from x/guests\n\nInvitados' } },
            ],
            files: [{ filename: 'apps/api/drizzle/0042_guests.sql' }],
          }
        : { workflow_runs: [run] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('/update', () => {
  it('recognises the command and names changes by their pull request', () => {
    expect(isUpdateCommand('/update')).toBe(true);
    expect(isUpdateCommand('/update@GbBot ')).toBe(true);
    expect(isUpdateCommand('/updates')).toBe(false);
    expect(changeLine('Merge pull request #34 from x/y\n\nInvitados')).toBe('#34 Invitados');
    expect(changeLine('Fix typo\n\nmore')).toBe('Fix typo');
  });

  it('is not offered until the server has been set up', async () => {
    expect(await checkForUpdate(env, fakeGithub({ status: 'completed', conclusion: 'success' }))).toEqual({
      state: 'not_configured',
    });
  });

  it('offers only versions whose checks passed', async () => {
    await configure();
    expect(await checkForUpdate(env, fakeGithub({ status: 'in_progress', conclusion: null }))).toMatchObject({
      state: 'ci_running',
    });
    expect(await checkForUpdate(env, fakeGithub({ status: 'completed', conclusion: 'failure' }))).toMatchObject({
      state: 'ci_failed',
    });
    const reply = await updateReply(env, 'es', fakeGithub({ status: 'completed', conclusion: 'success' }));
    expect(reply.text).toContain('#34 Invitados');
    expect(reply.text).not.toContain('Guests: lists');
    expect(reply.text).toContain('base de datos');
    expect(reply.keyboard?.inline_keyboard[0]?.[0]?.callback_data).toBe(`upd:${NEXT}`);
  });

  it('leaves the request for the server when a platform admin confirms', async () => {
    await configure();
    const telegram = new TelegramApi('1:abc');
    const answer = vi.spyOn(telegram, 'answerCallbackQuery').mockResolvedValue(true);
    const edit = vi.spyOn(telegram, 'editMessageText').mockResolvedValue(true);
    const query = (from: number) => ({
      id: 'q',
      from: { id: from },
      data: `upd:${NEXT}`,
      message: { message_id: 7, chat: { id: from, type: 'private' } },
    });

    // Anyone else: nothing happens.
    expect(await handleUpdateButton(env, telegram, query(99), 'en')).toBe(true);
    expect(edit).not.toHaveBeenCalled();

    expect(await handleUpdateButton(env, telegram, query(42), 'en')).toBe(true);
    const request = await readFile(join(env.UPDATE_DIR as string, 'request'), 'utf8');
    expect(request).toContain(`target=${NEXT}`);
    expect(request).toContain('chat=42');
    expect(request).toContain('message=7');
    expect(request).toContain('done=✅ Updated to bbbbbbb.');
    expect(edit).toHaveBeenCalledWith(42, 7, expect.stringContaining('Updating to bbbbbbb'));

    // A second press while it is pending does not ask again.
    await handleUpdateButton(env, telegram, query(42), 'en');
    expect(answer).toHaveBeenLastCalledWith('q', expect.stringContaining('already under way'));
    expect(await updateReply(env, 'en')).toEqual({ text: expect.stringContaining('already under way') });
  });
});
