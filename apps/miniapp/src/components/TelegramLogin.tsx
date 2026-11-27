import { useEffect, useRef, useState } from 'react';
import { Button } from '@telegram-apps/telegram-ui';
import { api, ApiClientError } from '../api/client.js';
import { t } from '../i18n/index.js';

/** How long the page waits for Telegram's window before giving up. */
const WAIT_MS = 10 * 60_000;
const EVERY_MS = 2_000;

/**
 * "Log in with Telegram" through the login bot (a bot apart from the shop's):
 * opens Telegram's own window, waits until Telegram has sent the person back
 * to the server, and hands over a one-time proof. Nothing from Telegram runs
 * in this page.
 */
export function TelegramLoginButton({
  onAuth,
  label,
}: {
  onAuth: (proof: string) => void;
  label?: string;
}): React.JSX.Element {
  const [waiting, setWaiting] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const start = async (): Promise<void> => {
    setNote(null);
    setLink(null);
    // Opened in the same tap (phones block windows opened later), then sent to Telegram.
    const popup = window.open('about:blank', 'gb-telegram-login', 'width=520,height=640');
    let started: { url: string; state: string };
    try {
      started = await api.telegramLoginStart();
    } catch (err) {
      popup?.close();
      setNote(err instanceof ApiClientError ? err.message : t('error.title'));
      return;
    }
    if (popup) popup.location.href = started.url;
    // Blocked anyway: a link to open it by hand.
    else setLink(started.url);
    setWaiting(true);
    const until = Date.now() + WAIT_MS;
    let timer = 0;
    stop.current = () => window.clearTimeout(timer);
    const check = async (): Promise<void> => {
      const { status } = await api.telegramLoginResult(started.state).catch(() => ({ status: 'waiting' as const }));
      if (status === 'ready') {
        setWaiting(false);
        setLink(null);
        try {
          popup?.close();
        } catch {
          // Telegram's page may have cut the link to it: the person closes it.
        }
        onAuth(started.state);
        return;
      }
      if (status === 'failed' || Date.now() > until) {
        setWaiting(false);
        setLink(null);
        setNote(t('acct.telegramFailed'));
        return;
      }
      timer = window.setTimeout(() => void check(), EVERY_MS);
    };
    timer = window.setTimeout(() => void check(), EVERY_MS);
  };

  return (
    <div style={{ padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Button stretched mode="bezeled" loading={waiting && !link} onClick={() => void start()}>
        {label ?? t('acct.telegramButton')}
      </Button>
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer" style={{ textAlign: 'center' }}>
          {t('acct.telegramOpen')}
        </a>
      )}
      {waiting && <span className="gb-hint" style={{ textAlign: 'center' }}>{t('acct.telegramWaiting')}</span>}
      {note && <span className="gb-hint" style={{ textAlign: 'center' }}>{note}</span>}
    </div>
  );
}
