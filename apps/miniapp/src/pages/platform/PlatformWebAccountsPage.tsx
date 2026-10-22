import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { WebAccountView, WebCredentials, WebRole } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { Input } from '../../components/Field.js';
import { Credentials } from '../../components/WebCredentials.js';
import { ErrorBanner, formatDate, useAdminActions } from '../admin/common.js';
import { t, type MessageKey } from '../../i18n/index.js';

const ROLE_LABEL: Record<WebRole, MessageKey> = {
  platform: 'webAccounts.role.platform',
  platform_limited: 'webAccounts.role.platform_limited',
  linked: 'webAccounts.role.linked',
};

function details(account: WebAccountView): string {
  return [
    t(ROLE_LABEL[account.role]),
    account.telegram ? t('webAccounts.linkedTo', { name: account.telegram.name }) : null,
    account.lastLoginAt
      ? t('webAccess.lastLogin', { date: formatDate(account.lastLoginAt) })
      : t('webAccess.neverUsed'),
    account.locked ? t('webAccounts.locked') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Full platform accounts: every web account, and new platform accounts. */
export function PlatformWebAccountsPage(): React.JSX.Element {
  const { webRole } = useSession();
  if (webRole !== 'platform') return <ErrorView message={t('webAccounts.only')} />;
  return <Accounts />;
}

function Accounts(): React.JSX.Element {
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const accounts = useAsync(() => api.webAccounts(), [reloadKey]);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<WebRole>('platform_limited');
  const [creds, setCreds] = useState<WebCredentials | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));

  if (accounts.error) return <ErrorView message={accounts.error} />;
  if (!accounts.data) return <Loader />;
  if (creds) {
    return (
      <List>
        <PageTitle title={t('webAccounts.title')} />
        <Credentials creds={creds} onDone={() => setCreds(null)} />
      </List>
    );
  }

  return (
    <List>
      <PageTitle title={t('webAccounts.title')} />
      <ErrorBanner message={actions.error} />
      <Section footer={t('webAccounts.footer')}>
        {accounts.data.map((account) => (
          <Cell
            key={account.id}
            multiline
            description={details(account)}
            after="›"
            onClick={() => navigate(`/platform/web-accounts/${account.id}`)}
          >
            {account.username}
            {account.isMe ? ` (${t('webAccounts.you')})` : ''}
          </Cell>
        ))}
      </Section>

      <Section header={t('webAccounts.newTitle')} footer={t('webAccounts.newFooter')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Input
            header={t('web.username')}
            value={username}
            autoCapitalize="none"
            maxLength={32}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
          />
          <RolePicker value={role} onChange={setRole} />
          <Button
            stretched
            loading={busy}
            disabled={username.trim().length < 3}
            onClick={() => {
              setBusy(true);
              void actions
                .run(async () => {
                  setCreds(await api.createWebAccount(username, role));
                  setUsername('');
                })
                .finally(() => setBusy(false));
            }}
          >
            {t('webAccounts.create')}
          </Button>
        </div>
      </Section>
    </List>
  );
}

function RolePicker({
  value,
  onChange,
}: {
  value: WebRole;
  onChange: (role: WebRole) => void;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {(['platform', 'platform_limited'] as const).map((role) => (
        <Button
          key={role}
          size="s"
          mode={value === role ? 'filled' : 'bezeled'}
          onClick={() => onChange(role)}
        >
          {t(ROLE_LABEL[role])}
        </Button>
      ))}
    </div>
  );
}

/** One web account: reset, change role (platform ones) or remove. */
export function PlatformWebAccountPage(): React.JSX.Element {
  const { webRole } = useSession();
  if (webRole !== 'platform') return <ErrorView message={t('webAccounts.only')} />;
  return <Account />;
}

function Account(): React.JSX.Element {
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const [reloadKey, setReloadKey] = useState(0);
  const accounts = useAsync(() => api.webAccounts(), [reloadKey]);
  const [creds, setCreds] = useState<WebCredentials | null>(null);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));

  if (accounts.error) return <ErrorView message={accounts.error} />;
  if (!accounts.data) return <Loader />;
  const account = accounts.data.find((a) => String(a.id) === id);
  if (!account) return <ErrorView message={t('webAccounts.notFound')} />;
  if (creds) {
    return (
      <List>
        <PageTitle title={account.username} />
        <Credentials creds={creds} onDone={() => setCreds(null)} />
      </List>
    );
  }

  return (
    <List>
      <PageTitle title={account.username} />
      <ErrorBanner message={actions.error} />
      <Section>
        <Cell multiline description={details(account)}>
          {account.username}
        </Cell>
      </Section>

      {account.role !== 'linked' && (
        <Section header={t('webAccounts.roleTitle')}>
          <div style={{ padding: 16 }}>
            <RolePicker
              value={account.role}
              onChange={(role) => void actions.run(() => api.setWebAccountRole(account.id, role))}
            />
          </div>
        </Section>
      )}

      <Section
        footer={
          account.role === 'linked'
            ? t('webAccounts.removeLinkedFooter')
            : t('webAccounts.resetFooter')
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            onClick={() =>
              void actions.twoTap('reset', async () =>
                setCreds(await api.resetWebAccount(account.id)),
              )
            }
          >
            {actions.tapLabel('reset', t('webAccess.renew'))}
          </Button>
          <Button
            stretched
            mode="plain"
            onClick={() =>
              void actions.twoTap('remove', async () => {
                await api.deleteWebAccount(account.id);
                navigate('/platform/web-accounts', { replace: true });
              })
            }
          >
            {actions.tapLabel('remove', t('webAccounts.remove'))}
          </Button>
        </div>
      </Section>
    </List>
  );
}
