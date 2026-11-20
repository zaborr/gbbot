import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lang } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import type { Env } from '../config/env.js';
import { tr, type BotMessageKey } from '../i18n/messages.js';
import type { InlineKeyboard, TelegramApi } from '../telegram/api.js';
import type { TelegramUpdate } from '../telegram/types.js';
import { busy as updateBusy, recent, updateDir } from './serverUpdate.js';
import { isSuperAdmin } from './shop.js';
import { notifyUsers } from './notifications.js';
import { botToken } from './activeBot.js';

/**
 * `/server` from the bot: platform administrators see how the server is and
 * run a few fixed maintenance tasks with buttons. Like `/update`, the API only
 * leaves a request in the folder shared with the server (`task`), where a
 * systemd unit (deploy/auto-update/task.sh) runs it as root and reports back.
 * The server writes `status` (deploy/auto-update/status.sh) every 15 minutes;
 * the API also warns the administrators when something there needs them.
 */
export const SERVER_ACTIONS = ['apt', 'reboot', 'backup', 'restart', 'prune'] as const;
export type ServerAction = (typeof SERVER_ACTIONS)[number];
/** Asked twice: they stop the bot or change the system. */
const CONFIRM: readonly ServerAction[] = ['apt', 'reboot', 'restart'];

export interface ServerStatus {
  /** Seconds since 1970 (the server's clock). */
  checked: number;
  uptime: number;
  load: string;
  cpus: number;
  /** Kilobytes. */
  memTotal: number;
  memAvail: number;
  diskTotal: number;
  diskAvail: number;
  diskPct: number;
  services: Array<{ name: string; state: string }>;
  backupLast: number | null;
  backupSize: number | null;
  offsite: boolean;
  offsiteOk: number | null;
  offsiteFailed: number | null;
  offsiteError: string | null;
  /** Null when the server has no apt. */
  aptPending: number | null;
  aptSecurity: number;
  reboot: boolean;
  rebootPkgs: string | null;
  unattended: 'on' | 'off' | 'missing' | null;
  unattendedLast: number | null;
}

/** Reads the `status` file (one `key=value` a line); null when it is not one. */
export function parseStatus(content: string): ServerStatus | null {
  const kv = new Map<string, string>();
  for (const line of content.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) kv.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const num = (key: string): number | null => {
    const value = kv.get(key);
    if (value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const checked = num('checked');
  if (checked === null) return null;
  const unattended = kv.get('unattended');
  return {
    checked,
    uptime: num('uptime') ?? 0,
    load: kv.get('load') ?? '',
    cpus: num('cpus') ?? 1,
    memTotal: num('mem_total') ?? 0,
    memAvail: num('mem_avail') ?? 0,
    diskTotal: num('disk_total') ?? 0,
    diskAvail: num('disk_avail') ?? 0,
    diskPct: num('disk_pct') ?? 0,
    services: (kv.get('services') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((pair) => {
        const [name = '', state = ''] = pair.split(':');
        return { name, state };
      }),
    backupLast: num('backup_last'),
    backupSize: num('backup_size'),
    offsite: kv.get('offsite') === 'on',
    offsiteOk: num('offsite_ok'),
    offsiteFailed: num('offsite_failed'),
    offsiteError: kv.get('offsite_error') || null,
    aptPending: num('apt_pending'),
    aptSecurity: num('apt_security') ?? 0,
    reboot: kv.get('reboot') === '1',
    rebootPkgs: kv.get('reboot_pkgs')?.trim() || null,
    unattended: unattended === 'on' || unattended === 'off' || unattended === 'missing' ? unattended : null,
    unattendedLast: num('unattended_last'),
  };
}

export async function readStatus(env: Env): Promise<ServerStatus | null> {
  try {
    return parseStatus(await readFile(join(updateDir(env), 'status'), 'utf8'));
  } catch {
    return null;
  }
}

/** A task or an update asked for or under way (old leftovers do not block). */
export async function serverBusy(env: Env): Promise<boolean> {
  const dir = updateDir(env);
  return (
    (await updateBusy(env)) ||
    (await recent(join(dir, 'task'), 10 * 60 * 1000)) ||
    (await recent(join(dir, 'task-running'), 60 * 60 * 1000))
  );
}

/** Leaves a request for task.sh: one value per line (no JSON in the shell). */
async function requestTask(env: Env, values: Record<string, string>): Promise<boolean> {
  const dir = updateDir(env);
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v.replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');
  try {
    await mkdir(dir, { recursive: true });
    // Written apart and then moved, so the server never reads half a file.
    await writeFile(join(dir, 'task.tmp'), `${body}\n`);
    await rename(join(dir, 'task.tmp'), join(dir, 'task'));
    return true;
  } catch (error) {
    console.error('Could not ask the server for a task:', error);
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks the server for a fresh status and waits for it (a while at most). */
export async function refreshStatus(env: Env, waitMs = 20_000): Promise<ServerStatus | null> {
  const before = await readStatus(env);
  if (await serverBusy(env)) return before;
  const asked = Math.floor(Date.now() / 1000);
  if (!(await requestTask(env, { action: 'status' }))) return before;
  for (let waited = 0; waited < waitMs; waited += 1000) {
    await sleep(1000);
    const now = await readStatus(env);
    if (now && now.checked >= asked && now.checked !== before?.checked) return now;
  }
  return before;
}

// --- How it reads ---

function ago(lang: Lang, seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 3600) return tr(lang, 'server.minutes', { n: Math.max(1, Math.round(s / 60)) });
  if (s < 2 * 86400) return tr(lang, 'server.hours', { n: Math.round(s / 3600) });
  return tr(lang, 'server.days', { n: Math.round(s / 86400) });
}
const gb = (kb: number): string => (kb / 1024 / 1024).toFixed(1);
const mb = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Disk use from which it warns. */
export const DISK_WARN_PCT = 85;
/** A database backup older than this is late (it runs once a day). */
export const BACKUP_LATE_S = 26 * 3600;

export function statusText(lang: Lang, s: ServerStatus, nowS = Date.now() / 1000): string {
  const lines = [tr(lang, 'server.title'), ''];
  lines.push(tr(lang, 'server.uptime', { time: ago(lang, s.uptime), load: s.load, cpus: s.cpus }));
  lines.push(tr(lang, 'server.memory', { used: gb(s.memTotal - s.memAvail), total: gb(s.memTotal) }));
  lines.push(
    `${s.diskPct >= DISK_WARN_PCT ? '⚠️ ' : ''}${tr(lang, 'server.disk', { pct: s.diskPct, free: gb(s.diskAvail) })}`,
  );
  const down = s.services.filter((x) => x.state !== 'running');
  lines.push(
    s.services.length === 0
      ? tr(lang, 'server.servicesUnknown')
      : down.length === 0
        ? tr(lang, 'server.servicesOk', { n: s.services.length })
        : tr(lang, 'server.servicesDown', { list: down.map((x) => `${x.name} (${x.state})`).join(', ') }),
  );
  if (s.backupLast === null) lines.push(tr(lang, 'server.backupNone'));
  else {
    const line = tr(lang, 'server.backup', { ago: ago(lang, nowS - s.backupLast), size: mb(s.backupSize ?? 0) });
    lines.push(`${nowS - s.backupLast > BACKUP_LATE_S ? '⚠️ ' : ''}${line}`);
  }
  if (!s.offsite) lines.push(tr(lang, 'server.offsiteOff'));
  else if (s.offsiteFailed !== null && (s.offsiteOk === null || s.offsiteFailed > s.offsiteOk)) {
    lines.push(tr(lang, 'server.offsiteFailed', { ago: ago(lang, nowS - s.offsiteFailed), error: s.offsiteError ?? '?' }));
  } else if (s.offsiteOk !== null) lines.push(tr(lang, 'server.offsiteOk', { ago: ago(lang, nowS - s.offsiteOk) }));
  else lines.push(tr(lang, 'server.offsiteNone'));
  if (s.aptPending !== null) {
    lines.push(
      s.aptPending === 0
        ? tr(lang, 'server.aptNone')
        : tr(lang, 'server.aptPending', { n: s.aptPending, security: s.aptSecurity }),
    );
  }
  if (s.reboot) lines.push(tr(lang, 'server.rebootNeeded', { pkgs: s.rebootPkgs ?? '—' }));
  if (s.unattended === 'on') {
    lines.push(
      s.unattendedLast !== null
        ? tr(lang, 'server.unattendedOnLast', { ago: ago(lang, nowS - s.unattendedLast) })
        : tr(lang, 'server.unattendedOn'),
    );
  } else if (s.unattended === 'off') lines.push(tr(lang, 'server.unattendedOff'));
  else if (s.unattended === 'missing') lines.push(tr(lang, 'server.unattendedMissing'));
  lines.push('');
  lines.push(
    nowS - s.checked > 3600
      ? tr(lang, 'server.checkedStale', { ago: ago(lang, nowS - s.checked) })
      : tr(lang, 'server.checked', { ago: ago(lang, nowS - s.checked) }),
  );
  return lines.join('\n');
}

const button = (text: string, data: string): { text: string; callback_data: string } => ({
  text,
  callback_data: data,
});

export function menuKeyboard(lang: Lang): InlineKeyboard {
  return {
    inline_keyboard: [
      [button(tr(lang, 'server.refresh'), 'srv:status')],
      [button(tr(lang, 'server.btn.apt'), 'srv:apt'), button(tr(lang, 'server.btn.backup'), 'srv:backup')],
      [button(tr(lang, 'server.btn.restart'), 'srv:restart'), button(tr(lang, 'server.btn.prune'), 'srv:prune')],
      [button(tr(lang, 'server.btn.reboot'), 'srv:reboot')],
    ],
  };
}

/** The `/server` message: the status and the buttons, or how to install it. */
export function serverMenu(
  lang: Lang,
  status: ServerStatus | null,
  isBusy: boolean,
): { text: string; keyboard?: InlineKeyboard } {
  if (!status) return { text: tr(lang, 'server.notConfigured') };
  const text = statusText(lang, status);
  return isBusy
    ? { text: `${text}\n\n${tr(lang, 'server.busy')}`, keyboard: { inline_keyboard: [[button(tr(lang, 'server.refresh'), 'srv:status')]] } }
    : { text, keyboard: menuKeyboard(lang) };
}

/** Whether a bot message is `/server` (also `/server@BotName`). */
export function isServerCommand(text: string): boolean {
  return /^\/server(@\w+)?\s*$/i.test(text.trim());
}

/** Shows the menu in a message, after asking the server for a fresh status. */
async function showFresh(env: Env, telegram: TelegramApi, chatId: number, messageId: number, lang: Lang): Promise<void> {
  const status = await refreshStatus(env);
  const menu = serverMenu(lang, status, await serverBusy(env));
  await telegram.editMessageText(chatId, messageId, menu.text, menu.keyboard);
}

/** `/server`: "checking…" at once, then the status (in the background: the webhook does not wait). */
export async function answerServerCommand(env: Env, telegram: TelegramApi, chatId: number, lang: Lang): Promise<void> {
  const sent = (await telegram.sendMessage(chatId, tr(lang, 'server.checking'))) as { message_id?: number } | undefined;
  if (!sent?.message_id) return;
  const messageId = sent.message_id;
  void showFresh(env, telegram, chatId, messageId, lang).catch((error: unknown) =>
    console.error('Could not show the server status:', error),
  );
}

const ASK: Record<ServerAction, BotMessageKey> = {
  apt: 'server.ask.apt',
  reboot: 'server.ask.reboot',
  restart: 'server.ask.restart',
  backup: 'server.running.backup',
  prune: 'server.running.prune',
};
const RUNNING: Record<ServerAction, BotMessageKey> = {
  apt: 'server.running.apt',
  reboot: 'server.running.reboot',
  restart: 'server.running.restart',
  backup: 'server.running.backup',
  prune: 'server.running.prune',
};
const DONE: Record<ServerAction, BotMessageKey> = {
  apt: 'server.done.apt',
  reboot: 'server.done.reboot',
  restart: 'server.done.restart',
  backup: 'server.done.backup',
  prune: 'server.done.prune',
};
const FAILED: Record<ServerAction, BotMessageKey> = {
  apt: 'server.failed.apt',
  reboot: 'server.failed.reboot',
  restart: 'server.failed.restart',
  backup: 'server.failed.backup',
  prune: 'server.failed.prune',
};

/** The buttons under the `/server` message. Returns false when the button is not one of them. */
export async function handleServerButton(
  env: Env,
  telegram: TelegramApi,
  query: NonNullable<TelegramUpdate['callback_query']>,
  lang: Lang,
): Promise<boolean> {
  const match = /^srv:(status|back|apt|reboot|backup|restart|prune)(!?)$/.exec(query.data ?? '');
  if (!match) return false;
  if (!isSuperAdmin(env, query.from.id)) {
    await telegram.answerCallbackQuery(query.id);
    return true;
  }
  const message = query.message;
  const chatId = message?.chat.id ?? query.from.id;
  const what = match[1] as ServerAction | 'status' | 'back';
  const confirmed = match[2] === '!';

  if (what === 'status' || what === 'back') {
    await telegram.answerCallbackQuery(query.id);
    if (!message) return true;
    if (what === 'back') {
      const menu = serverMenu(lang, await readStatus(env), await serverBusy(env));
      await telegram.editMessageText(chatId, message.message_id, menu.text, menu.keyboard);
      return true;
    }
    await telegram.editMessageText(chatId, message.message_id, tr(lang, 'server.checking'));
    void showFresh(env, telegram, chatId, message.message_id, lang).catch((error: unknown) =>
      console.error('Could not show the server status:', error),
    );
    return true;
  }

  if (await serverBusy(env)) {
    await telegram.answerCallbackQuery(query.id, tr(lang, 'server.busy'));
    return true;
  }
  // First tap: what it will do, and the button to go ahead.
  if (CONFIRM.includes(what) && !confirmed) {
    await telegram.answerCallbackQuery(query.id);
    const status = await readStatus(env);
    const text = tr(lang, ASK[what], { n: status?.aptPending ?? '?' });
    const keyboard: InlineKeyboard = {
      inline_keyboard: [[button(tr(lang, 'server.go'), `srv:${what}!`), button(tr(lang, 'server.back'), 'srv:back')]],
    };
    if (message) await telegram.editMessageText(chatId, message.message_id, text, keyboard);
    else await telegram.sendMessage(chatId, text, keyboard);
    return true;
  }

  const ok = await requestTask(env, {
    action: what,
    chat: String(chatId),
    message: message ? String(message.message_id) : '',
    done: tr(lang, DONE[what]),
    failed: tr(lang, FAILED[what]),
    ...(what === 'apt'
      ? { done_reboot: tr(lang, 'server.done.aptReboot'), reboot_label: tr(lang, 'server.btn.reboot') }
      : {}),
  });
  await telegram.answerCallbackQuery(query.id, ok ? undefined : tr(lang, 'server.notConfigured'));
  if (ok && message) await telegram.editMessageText(chatId, message.message_id, tr(lang, RUNNING[what]));
  return true;
}

// --- Warnings ---

export interface ServerWarning {
  key: 'disk' | 'services' | 'backup' | 'security' | 'reboot' | 'stale';
  /** Sent again while it lasts, at most this often. */
  everyS: number;
  /** Only once it has lasted this long. */
  afterS: number;
  text: (lang: Lang) => string;
}

/** What in the status needs the administrators now. */
export function serverWarnings(s: ServerStatus, nowS = Date.now() / 1000): ServerWarning[] {
  const day = 86400;
  const list: ServerWarning[] = [];
  if (nowS - s.checked > 3600) {
    // Old figures: only that is said.
    return [{ key: 'stale', everyS: day, afterS: 0, text: (l) => tr(l, 'server.warn.stale', { ago: ago(l, nowS - s.checked) }) }];
  }
  if (s.diskPct >= DISK_WARN_PCT) {
    list.push({ key: 'disk', everyS: 6 * 3600, afterS: 0, text: (l) => tr(l, 'server.warn.disk', { pct: s.diskPct, free: gb(s.diskAvail) }) });
  }
  const down = s.services.filter((x) => x.state !== 'running');
  if (down.length > 0) {
    // A restart or an update stops them for a moment.
    list.push({
      key: 'services',
      everyS: 6 * 3600,
      afterS: 10 * 60,
      text: (l) => tr(l, 'server.warn.services', { list: down.map((x) => `${x.name} (${x.state})`).join(', ') }),
    });
  }
  const last = s.backupLast;
  if (last === null || nowS - last > BACKUP_LATE_S) {
    list.push({
      key: 'backup',
      everyS: day,
      afterS: 0,
      text: (l) => (last === null ? tr(l, 'server.warn.backupNone') : tr(l, 'server.warn.backup', { ago: ago(l, nowS - last) })),
    });
  }
  if (s.aptSecurity > 0) {
    // With automatic updates on, they are installed on their own: a day's grace.
    list.push({
      key: 'security',
      everyS: day,
      afterS: s.unattended === 'on' ? day : 0,
      text: (l) => tr(l, 'server.warn.security', { n: s.aptSecurity }),
    });
  }
  if (s.reboot) {
    list.push({ key: 'reboot', everyS: day, afterS: 0, text: (l) => tr(l, 'server.warn.reboot', { pkgs: s.rebootPkgs ?? '—' }) });
  }
  return list;
}

/** Since when each warning lasts and when it was last sent (seconds). */
type WarnState = Record<string, { since: number; sent: number | null }>;

/** Which warnings to send now, and the state to keep. Gone ones are forgotten. */
export function dueWarnings(
  warnings: ServerWarning[],
  state: WarnState,
  nowS: number,
): { due: ServerWarning[]; state: WarnState } {
  const next: WarnState = {};
  const due: ServerWarning[] = [];
  for (const w of warnings) {
    const was = state[w.key] ?? { since: nowS, sent: null };
    const send = nowS - was.since >= w.afterS && (was.sent === null || nowS - was.sent >= w.everyS);
    if (send) due.push(w);
    next[w.key] = { since: was.since, sent: send ? nowS : was.sent };
  }
  return { due, state: next };
}

export async function checkServerWarnings(db: Database, env: Env): Promise<number> {
  const status = await readStatus(env);
  // Not installed: nothing to watch.
  if (!status || env.ADMIN_TELEGRAM_IDS.length === 0) return 0;
  const path = join(updateDir(env), 'warnings.json');
  let state: WarnState = {};
  try {
    state = JSON.parse(await readFile(path, 'utf8')) as WarnState;
  } catch {
    // First time, or unreadable: start again.
  }
  const nowS = Math.floor(Date.now() / 1000);
  const { due, state: next } = dueWarnings(serverWarnings(status, nowS), state, nowS);
  if (due.length > 0) {
    await notifyUsers(db, botToken(env), [...env.ADMIN_TELEGRAM_IDS], (lang) =>
      [...due.map((w) => w.text(lang)), '', tr(lang, 'server.warn.footer')].join('\n'),
    );
  }
  await writeFile(path, JSON.stringify(next));
  return due.length;
}

/** Every 15 minutes (the first a few minutes after starting). */
export function scheduleServerWarnings(db: Database, env: Env): void {
  const run = (): void => {
    checkServerWarnings(db, env).catch((error: unknown) => console.error('Server warnings failed:', error));
  };
  setTimeout(run, 3 * 60 * 1000).unref();
  setInterval(run, 15 * 60 * 1000).unref();
}
