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
import { Address, Credentials } from '../components/WebCredentials.js';
import { ErrorBanner, formatDate, useAdminActions } from './admin/common.js';
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
