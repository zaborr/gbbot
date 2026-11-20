import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import type { TelegramApi } from '../telegram/api.js';
import type { TelegramUpdate } from '../telegram/types.js';
import { dueWarnings, handleServerButton, parseStatus, serverWarnings, statusText } from './serverTasks.js';

const NOW = 1_800_000_000;
const STATUS = [
  `checked=${NOW - 60}`,
  'uptime=90000',
  'load=0.10 0.20 0.30',
  'cpus=2',
  'mem_total=4000000',
  'mem_avail=1000000',
  'disk_total=40000000',
  'disk_avail=4000000',
  'disk_pct=90',
  'services=api:running caddy:exited postgres:running ',
  `backup_last=${NOW - 30 * 3600}`,
  'backup_size=3000000',
  'offsite=on',
  `offsite_ok=${NOW - 40 * 3600}`,
  `offsite_failed=${NOW - 30 * 3600}`,
  'offsite_error=rclone',
  'apt_pending=5',
  'apt_security=2',
  'reboot=1',
  'reboot_pkgs=linux-image-amd64 ',
  'unattended=on',
  `unattended_last=${NOW - 3 * 3600}`,
].join('\n');

describe('server status', () => {
  it('reads the status file the server writes', () => {
    const s = parseStatus(STATUS)!;
    expect(s).toMatchObject({
      diskPct: 90,
      aptPending: 5,
      aptSecurity: 2,
      reboot: true,
      rebootPkgs: 'linux-image-amd64',
      unattended: 'on',
      offsiteError: 'rclone',
    });
    expect(s.services).toEqual([
      { name: 'api', state: 'running' },
      { name: 'caddy', state: 'exited' },
      { name: 'postgres', state: 'running' },
    ]);
    expect(parseStatus('nothing here')).toBeNull();
  });

  it('says what matters, and what is wrong', () => {
    const text = statusText('es', parseStatus(STATUS)!, NOW);
    expect(text).toContain('caddy (exited)');
    expect(text).toContain('rclone');
    expect(text).toContain('⚠️');
    expect(text).toContain('5');
  });

  it('warns once, again only after a while, and forgets what is fixed', () => {
    const warnings = serverWarnings(parseStatus(STATUS)!, NOW);
    expect(warnings.map((w) => w.key).sort()).toEqual(['backup', 'disk', 'reboot', 'security', 'services']);
    // Containers just stopped (a restart) and security updates the system installs on its own: not yet.
    const first = dueWarnings(warnings, {}, NOW);
    expect(first.due.map((w) => w.key).sort()).toEqual(['backup', 'disk', 'reboot']);
    expect(dueWarnings(warnings, first.state, NOW + 5 * 60).due).toEqual([]);
    expect(dueWarnings(warnings, first.state, NOW + 3600).due.map((w) => w.key)).toEqual(['services']);
    const later = dueWarnings(warnings, first.state, NOW + 25 * 3600);
    expect(later.due.map((w) => w.key).sort()).toEqual(['backup', 'disk', 'reboot', 'security', 'services']);
    expect(dueWarnings([], later.state, NOW + 26 * 3600).state).toEqual({});
    // Old figures: only that.
    expect(serverWarnings(parseStatus(STATUS)!, NOW + 2 * 3600).map((w) => w.key)).toEqual(['stale']);
  });
});

describe('/server buttons', () => {
  const setup = async (): Promise<{ env: Env; dir: string; telegram: TelegramApi }> => {
    const dir = await mkdtemp(join(tmpdir(), 'gb-server-'));
    await writeFile(join(dir, 'status'), STATUS);
    const env = { UPDATE_DIR: dir, ADMIN_TELEGRAM_IDS: [1] } as unknown as Env;
    const telegram = {
      answerCallbackQuery: vi.fn(async () => true),
      editMessageText: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({})),
    } as unknown as TelegramApi;
    return { env, dir, telegram };
  };
  const press = (data: string, from = 1): NonNullable<TelegramUpdate['callback_query']> =>
    ({ id: 'q', from: { id: from }, data, message: { message_id: 9, chat: { id: from } } }) as never;

  it('asks before what stops the bot or changes the system, then leaves a fixed request', async () => {
    const { env, dir, telegram } = await setup();
    expect(await handleServerButton(env, telegram, press('srv:reboot'), 'es')).toBe(true);
    await expect(readFile(join(dir, 'task'), 'utf8')).rejects.toThrow();
    expect(await handleServerButton(env, telegram, press('srv:reboot!'), 'es')).toBe(true);
    const task = await readFile(join(dir, 'task'), 'utf8');
    expect(task).toContain('action=reboot\n');
    expect(task).toContain('chat=1\n');
    expect(task).toContain('message=9\n');
    // One at a time.
    expect(await handleServerButton(env, telegram, press('srv:backup'), 'es')).toBe(true);
    expect(telegram.answerCallbackQuery).toHaveBeenLastCalledWith('q', expect.any(String));
  });

  it('does nothing for anyone else, and ignores buttons that are not its own', async () => {
    const { env, dir, telegram } = await setup();
    expect(await handleServerButton(env, telegram, press('srv:backup', 2), 'es')).toBe(true);
    await expect(readFile(join(dir, 'task'), 'utf8')).rejects.toThrow();
    expect(await handleServerButton(env, telegram, press('srv:rm -rf'), 'es')).toBe(false);
  });
});
