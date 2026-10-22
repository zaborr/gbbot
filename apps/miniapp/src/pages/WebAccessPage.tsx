import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { WebCredentials } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useSession } from '../providers/SessionProvider.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { PageTitle } from '../components/PageTitle.js';
import { Input } from '../components/Field.js';
import { QrCode } from '../components/QrCode.js';
import { ErrorBanner, formatDate, useAdminActions } from './admin/common.js';
import { copyText } from '../lib/clipboard.js';
import { t } from '../i18n/index.js';

/** A suggested username: the Telegram one, as far as web usernames allow. */
function suggestedUsername(username: string | null | undefined): string {
  return (username ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '')
    .slice(0, 32);
}

/**
 * Web access for managers: they activate it here (their Telegram account
 * proves who they are) and use the web panel with the same permissions.
 */
export function WebAccessPage(): React.JSX.Element {
  const { user } = useSession();
  const [reloadKey, setReloadKey] = useState(0);
  const status = useAsync(() => api.getWebAccess(), [reloadKey]);
  const [username, setUsername] = useState(() => suggestedUsername(user?.username));
  const [creds, setCreds] = useState<WebCredentials | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));

  if (status.error) return <ErrorView message={status.error} />;
  if (!status.data) return <Loader />;
  const { account, onionUrl } = status.data;

  const act = (action: () => Promise<unknown>): void => {
    setBusy(true);
    void actions.run(action).finally(() => setBusy(false));
  };

  return (
    <List>
      <PageTitle title={t('webAccess.title')} />
      <ErrorBanner message={actions.error} />

      {creds ? (
        <Credentials creds={creds} onDone={() => setCreds(null)} />
      ) : account ? (
        <>
          <Section
            footer={
              account.lastLoginAt
                ? t('webAccess.lastLogin', { date: formatDate(account.lastLoginAt) })
                : t('webAccess.neverUsed')
            }
          >
            <Cell subtitle={t('web.username')}>{account.username}</Cell>
            <Address onionUrl={onionUrl} />
          </Section>
          <Section footer={t('webAccess.renewFooter')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
              <Button
                stretched
                mode="bezeled"
                loading={busy}
                onClick={() =>
                  void actions.twoTap('renew', async () => setCreds(await api.resetWebAccess()))
                }
              >
                {actions.tapLabel('renew', t('webAccess.renew'))}
              </Button>
              <Button
                stretched
                mode="plain"
                onClick={() => void actions.twoTap('off', () => api.deleteWebAccess())}
              >
                {actions.tapLabel('off', t('webAccess.turnOff'))}
              </Button>
            </div>
          </Section>
        </>
      ) : (
        <Section header={t('webAccess.activateTitle')} footer={t('webAccess.activateFooter')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
            <Input
              header={t('web.username')}
              value={username}
              autoCapitalize="none"
              maxLength={32}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
            />
            <Button
              stretched
              loading={busy}
              disabled={username.trim().length < 3}
              onClick={() => act(async () => setCreds(await api.createWebAccess(username)))}
            >
              {t('webAccess.activate')}
            </Button>
          </div>
        </Section>
      )}
    </List>
  );
}

function Address({ onionUrl }: { onionUrl: string | null }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  if (!onionUrl) {
    return (
      <Cell multiline subtitle={t('webAccess.address')}>
        {t('webAccess.askAddress')}
      </Cell>
    );
  }
  return (
    <Cell
      multiline
      subtitle={t('webAccess.address')}
      description={t('webAccess.addressHint')}
      after={
        <Button
          size="s"
          mode="bezeled"
          onClick={() => void copyText(onionUrl).then((ok) => setCopied(ok))}
        >
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      }
    >
      <span style={{ wordBreak: 'break-all' }}>{onionUrl}</span>
    </Cell>
  );
}

/** Shown once, right after activating or renewing. */
function Credentials({
  creds,
  onDone,
}: {
  creds: WebCredentials;
  onDone: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string): void => {
    void copyText(text).then((ok) => setCopied(ok ? key : null));
  };
  const copyButton = (key: string, text: string): React.JSX.Element => (
    <Button size="s" mode="bezeled" onClick={() => copy(key, text)}>
      {copied === key ? t('common.copied') : t('common.copy')}
    </Button>
  );

  return (
    <>
      <Section header={t('webAccess.onceTitle')} footer={t('webAccess.onceFooter')}>
        <Cell subtitle={t('web.username')}>{creds.username}</Cell>
        <Cell subtitle={t('web.password')} after={copyButton('password', creds.password)}>
          <code style={{ wordBreak: 'break-all' }}>{creds.password}</code>
        </Cell>
        <Address onionUrl={creds.onionUrl} />
      </Section>

      <Section header={t('webAccess.authTitle')} footer={t('webAccess.authFooter')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
          <Button
            stretched
            onClick={() => {
              window.location.href = creds.otpauth;
            }}
          >
            {t('webAccess.addToApp')}
          </Button>
          <QrCode text={creds.otpauth} />
        </div>
        <Cell
          multiline
          subtitle={t('webAccess.secret')}
          after={copyButton('secret', creds.totpSecret)}
        >
          <code style={{ wordBreak: 'break-all' }}>{creds.totpSecret}</code>
        </Cell>
      </Section>

      <Section>
        <div style={{ padding: 16 }}>
          <Button stretched mode="bezeled" onClick={onDone}>
            {t('webAccess.saved')}
          </Button>
        </div>
      </Section>
    </>
  );
}
