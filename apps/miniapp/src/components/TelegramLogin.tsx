import { useState } from 'react';
import { Button } from '@telegram-apps/telegram-ui';
import { api, ApiClientError } from '../api/client.js';
import { t } from '../i18n/index.js';

/** What the page was doing when it went to Telegram (it gets it back on return). */
export type TelegramPurpose = 'login' | 'signup' | 'confirm' | 'reset' | 'manage';
export interface TelegramContext {
  p: TelegramPurpose;
  /** The invitation, when signing up with one. */
  c?: string;
}

const PURPOSES: TelegramPurpose[] = ['login', 'signup', 'confirm', 'reset', 'manage'];

export function parseTelegramContext(raw: string): TelegramContext {
  try {
    const value = JSON.parse(raw) as { p?: unknown; c?: unknown };
    const p = PURPOSES.includes(value.p as TelegramPurpose) ? (value.p as TelegramPurpose) : 'login';
    return typeof value.c === 'string' && value.c !== '' ? { p, c: value.c } : { p };
  } catch {
    return { p: 'login' };
  }
}

/**
 * "Log in with Telegram" through the login bot (a bot apart from the shop's),
 * in this same tab: the page goes to Telegram and Telegram sends it back to
 * `#/tg?t=…` (TelegramReturn), already confirmed. No second window to come
 * back to. Nothing from Telegram runs in this page.
 */
export function TelegramLoginButton({
  purpose,
  code,
  label,
}: {
  purpose: TelegramPurpose;
  code?: string;
  label?: string;
}): React.JSX.Element {
  const [going, setGoing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const start = (): void => {
    setGoing(true);
    setNote(null);
    const context: TelegramContext = code ? { p: purpose, c: code } : { p: purpose };
    void api
      .telegramLoginStart(JSON.stringify(context))
      .then(({ url }) => window.location.assign(url))
      .catch((err: unknown) => {
        setGoing(false);
        setNote(err instanceof ApiClientError ? err.message : t('error.title'));
      });
  };
  return (
    <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Button stretched mode="bezeled" loading={going} onClick={start}>
        {label ?? t('acct.telegramButton')}
      </Button>
      {note && <span className="gb-hint" style={{ textAlign: 'center' }}>{note}</span>}
    </div>
  );
}

/** Back from Telegram (`#/tg?t=…`): the ticket, taken out of the address. */
export function ticketFromAddress(): string | null {
  const [path, query] = window.location.hash.replace(/^#/, '').split('?');
  if (path !== '/tg') return null;
  const ticket = new URLSearchParams(query ?? '').get('t');
  window.history.replaceState(null, '', `${window.location.pathname}#/tg`);
  return ticket;
}

export const isTelegramReturn = (): boolean => /^#\/tg(\?|$)/.test(window.location.hash);

const STASH = 'gb:tg';

/** A confirmation for a screen of the signed-in page (it picks it up when it opens). */
export function stashTelegram(purpose: TelegramPurpose, ticket: string): void {
  window.sessionStorage.setItem(STASH, JSON.stringify({ p: purpose, t: ticket }));
}

/** The confirmation waiting for this screen, used once. */
export function takeTelegram(purpose: TelegramPurpose): string | null {
  const raw = window.sessionStorage.getItem(STASH);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { p?: unknown; t?: unknown };
    if (value.p !== purpose || typeof value.t !== 'string') return null;
    window.sessionStorage.removeItem(STASH);
    return value.t;
  } catch {
    window.sessionStorage.removeItem(STASH);
    return null;
  }
}
