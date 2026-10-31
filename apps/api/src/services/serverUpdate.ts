import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lang } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import { tr } from '../i18n/messages.js';
import type { InlineKeyboard, TelegramApi } from '../telegram/api.js';
import type { TelegramUpdate } from '../telegram/types.js';
import { isSuperAdmin } from './shop.js';

/**
 * `/update` from the bot: platform administrators see what is new on GitHub
 * and confirm with a button. The API cannot rebuild its own container, so it
 * only leaves a request in a folder shared with the server, where a systemd
 * unit (deploy/auto-update) runs deploy/update.sh and reports back.
 *
 * Files in that folder (written by the server unless noted):
 *   repo      "owner/name" of the GitHub repository
 *   current   commit now running
 *   request   written by the API: what to install and where to report
 *   running   the request being installed right now
 */
export const UPDATE_DIR_DEFAULT = '/run/gb-update';

const GITHUB = 'https://api.github.com';

interface GithubCommit {
  sha: string;
  commit: { message: string };
}

export type UpdateCheck =
  | { state: 'not_configured' }
  | { state: 'up_to_date'; current: string }
  | { state: 'ci_running' | 'ci_failed'; target: string }
  | {
      state: 'available';
      target: string;
      changes: string[];
      migrations: boolean;
    };

function updateDir(env: Env): string {
  return env.UPDATE_DIR ?? UPDATE_DIR_DEFAULT;
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** Whether the file is there and newer than `maxAgeMs`. */
async function recent(path: string, maxAgeMs: number, now = Date.now()): Promise<boolean> {
  try {
    return now - (await stat(path)).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

async function github<T>(path: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${GITHUB}${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'gb-bot-update' },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return (await res.json()) as T;
}

/** "Merge pull request #34 from x/y\n\nTitle" → "#34 Title"; other commits: their first line. */
export function changeLine(message: string): string {
  const [first = '', ...rest] = message.split('\n');
  const pr = /^Merge pull request (#\d+)/.exec(first);
  if (pr) {
    const title = rest.map((l) => l.trim()).find((l) => l !== '');
    return title ? `${pr[1]} ${title}` : (pr[1] as string);
  }
  return first.trim();
}

/** What `/update` would install: the newest commit of the default branch, if its CI passed. */
export async function checkForUpdate(env: Env, fetchImpl: typeof fetch = fetch): Promise<UpdateCheck> {
  const dir = updateDir(env);
  const [repo, current] = await Promise.all([readText(join(dir, 'repo')), readText(join(dir, 'current'))]);
  if (!repo || !current || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { state: 'not_configured' };

  const info = await github<{ default_branch: string }>(`/repos/${repo}`, fetchImpl);
  const compare = await github<{
    status: string;
    commits: GithubCommit[];
    files?: Array<{ filename: string }>;
  }>(`/repos/${repo}/compare/${current}...${info.default_branch}`, fetchImpl);
  const last = compare.commits.at(-1);
  if (compare.status === 'identical' || compare.status === 'behind' || !last) {
    return { state: 'up_to_date', current };
  }

  const runs = await github<{ workflow_runs: Array<{ status: string; conclusion: string | null }> }>(
    `/repos/${repo}/actions/runs?per_page=1&head_sha=${last.sha}`,
    fetchImpl,
  );
  const run = runs.workflow_runs[0];
  if (!run || run.status !== 'completed') return { state: 'ci_running', target: last.sha };
  if (run.conclusion !== 'success') return { state: 'ci_failed', target: last.sha };

  // Merges of pull requests say it best; the commits inside them are left out.
  const merges = compare.commits.filter((c) => c.commit.message.startsWith('Merge pull request'));
  const changes = (merges.length > 0 ? merges : compare.commits).map((c) => changeLine(c.commit.message));
  return {
    state: 'available',
    target: last.sha,
    changes,
    migrations: (compare.files ?? []).some((f) => /^apps\/api\/drizzle\/[^/]+\.sql$/.test(f.filename)),
  };
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * An update already asked for or under way. Old leftovers (the server
 * restarted mid-update, or nothing picked the request up) do not block.
 */
async function busy(env: Env): Promise<boolean> {
  const dir = updateDir(env);
  return (
    (await recent(join(dir, 'request'), 10 * 60 * 1000)) ||
    (await recent(join(dir, 'running'), 60 * 60 * 1000))
  );
}

/** The bot's answer to `/update`. */
export async function updateReply(
  env: Env,
  lang: Lang,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  if (await busy(env)) return { text: tr(lang, 'update.busy') };
  let check: UpdateCheck;
  try {
    check = await checkForUpdate(env, fetchImpl);
  } catch (error) {
    return {
      text: tr(lang, 'update.checkFailed', { error: error instanceof Error ? error.message : '?' }),
    };
  }
  switch (check.state) {
    case 'not_configured':
      return { text: tr(lang, 'update.notConfigured') };
    case 'up_to_date':
      return { text: tr(lang, 'update.upToDate', { version: short(check.current) }) };
    case 'ci_running':
      return { text: tr(lang, 'update.ciRunning', { version: short(check.target) }) };
    case 'ci_failed':
      return { text: tr(lang, 'update.ciFailed', { version: short(check.target) }) };
    case 'available': {
      const list = check.changes.slice(0, 15).map((c) => `• ${c}`);
      if (check.changes.length > 15) list.push(`• … (+${check.changes.length - 15})`);
      return {
        text: [
          tr(lang, 'update.available', { version: short(check.target) }),
          '',
          ...list,
          ...(check.migrations ? ['', tr(lang, 'update.migrations')] : []),
        ].join('\n'),
        keyboard: {
          inline_keyboard: [
            [
              { text: tr(lang, 'update.install'), callback_data: `upd:${check.target}` },
              { text: tr(lang, 'update.cancel'), callback_data: 'upd:no' },
            ],
          ],
        },
      };
    }
  }
}

/** Whether a bot message is `/update` (also `/update@BotName`). */
export function isUpdateCommand(text: string): boolean {
  return /^\/update(@\w+)?\s*$/i.test(text.trim());
}

/** The buttons under the `/update` answer. Returns false when the button is not one of them. */
export async function handleUpdateButton(
  env: Env,
  telegram: TelegramApi,
  query: NonNullable<TelegramUpdate['callback_query']>,
  lang: Lang,
): Promise<boolean> {
  const match = /^upd:([0-9a-f]{40}|no)$/.exec(query.data ?? '');
  if (!match) return false;
  if (!isSuperAdmin(env, query.from.id)) {
    await telegram.answerCallbackQuery(query.id);
    return true;
  }
  const message = query.message;
  const edit = async (text: string): Promise<void> => {
    if (message) await telegram.editMessageText(message.chat.id, message.message_id, text);
  };
  if (match[1] === 'no') {
    await telegram.answerCallbackQuery(query.id);
    await edit(tr(lang, 'update.cancelled'));
    return true;
  }
  if (await busy(env)) {
    await telegram.answerCallbackQuery(query.id, tr(lang, 'update.busy'));
    return true;
  }
  const target = match[1] as string;
  const version = short(target);
  // One value per line, read by the server's shell script (no JSON there).
  const request = [
    `target=${target}`,
    `chat=${message?.chat.id ?? query.from.id}`,
    `message=${message?.message_id ?? ''}`,
    `done=${tr(lang, 'update.done', { version })}`,
    `failed=${tr(lang, 'update.failed', { version })}`,
  ].join('\n');
  const dir = updateDir(env);
  try {
    await mkdir(dir, { recursive: true });
    // Written apart and then moved, so the server never reads half a file.
    await writeFile(join(dir, 'request.tmp'), `${request}\n`);
    await rename(join(dir, 'request.tmp'), join(dir, 'request'));
  } catch (error) {
    console.error('Could not ask for the update:', error);
    await telegram.answerCallbackQuery(query.id, tr(lang, 'update.notConfigured'));
    return true;
  }
  await telegram.answerCallbackQuery(query.id);
  await edit(tr(lang, 'update.running', { version }));
  return true;
}
