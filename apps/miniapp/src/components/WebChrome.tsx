import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, List, Section } from '@telegram-apps/telegram-ui';
import { useSession } from '../providers/SessionProvider.js';
import { useWebButton } from '../lib/web.js';
import { Input } from './Field.js';
import { PageTitle } from './PageTitle.js';
import { ApiClientError } from '../api/client.js';
import { t } from '../i18n/index.js';

const SHOP_ROOT = /^\/s\/[^/]+\/?$/;
const SHOP_ADMIN = /^\/s\/[^/]+\/admin\/?$/;

/**
 * Web mode: what Telegram draws around the app. A bar on top (back, the
 * signed-in administrator, sign out) …
 */
export function WebTopBar(): React.JSX.Element {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, signOut } = useSession();
  // In a browser the catalog leads to the admin screens, so going back from
  // there (or the catalog) goes to the list of GBs.
  const toList = SHOP_ROOT.test(pathname) || SHOP_ADMIN.test(pathname);
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: 'var(--tgui--secondary_bg_color)',
        borderBottom: '1px solid var(--tgui--outline, rgba(127,127,127,0.2))',
      }}
    >
      {pathname !== '/' && (
        <Button size="s" mode="plain" onClick={() => (toList ? navigate('/') : navigate(-1))}>
          ‹ {t('web.back')}
        </Button>
      )}
      <span style={{ flex: 1, textAlign: 'right', opacity: 0.7, fontSize: 14 }}>
        {user?.username}
      </span>
      <Button size="s" mode="bezeled" onClick={signOut}>
        {t('web.signOut')}
      </Button>
    </div>
  );
}

/** … and the button at the bottom that screens use for their main action. */
export function WebMainButton(): React.JSX.Element | null {
  const button = useWebButton();
  if (!button.visible) return null;
  return (
    <>
      {/* Room for the button, so it never covers the end of the screen. */}
      <div style={{ height: 80 }} />
      <div
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10,
          padding: 12,
          background: 'var(--tgui--secondary_bg_color)',
        }}
      >
        <Button
          size="l"
          stretched
          loading={button.loading}
          disabled={!button.enabled}
          onClick={() => button.onClick?.()}
        >
          {button.text}
        </Button>
      </div>
    </>
  );
}

/** Sign-in of a web administrator: username, password and authenticator code. */
export function WebSignIn(): React.JSX.Element {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password, code.trim());
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('app.signInFailed'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <List style={{ maxWidth: 420, margin: '0 auto' }}>
      <PageTitle title={t('web.title')} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Section footer={error ?? t('web.footer')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
            <Input
              header={t('web.username')}
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              onChange={(e) => setUsername(e.target.value)}
            />
            <Input
              header={t('web.password')}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
            <Input
              header={t('web.code')}
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Button
              type="submit"
              size="l"
              stretched
              loading={busy}
              disabled={!username.trim() || !password || code.length !== 6}
            >
              {t('web.signIn')}
            </Button>
          </div>
        </Section>
      </form>
    </List>
  );
}
