import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { CreatorAccountInfo, CreatorLoginStep } from '@tma-shop/shared';
import { Input } from '../../components/Field.js';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { ErrorBanner, formatDate, useAdminActions } from '../admin/common.js';
import { ACCOUNT_CHIP } from './PlatformBotsPage.js';
import { t } from '../../i18n/index.js';

/** A creator account: adding it (number → code → password) or seeing and signing it in again. */
export function PlatformCreatorAccountPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  const { id } = useParams();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return id === 'new' ? <NewAccount /> : <Account id={Number(id)} />;
}

const PHONE_RE = /^\+\d{7,15}$/;
const HASH_RE = /^[0-9a-f]{32}$/i;
const cleanPhone = (text: string): string => text.trim().replace(/[\s()-]/g, '');

function NewAccount(): React.JSX.Element {
  const navigate = useNavigate();
  const actions = useAdminActions(() => undefined);
  const [phone, setPhone] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [step, setStep] = useState<CreatorLoginStep | null>(null);

  const valid = PHONE_RE.test(cleanPhone(phone)) && /^\d+$/.test(apiId.trim()) && HASH_RE.test(apiHash.trim());
  const send = (): void =>
    void actions.run(async () => {
      setStep(
        await api.platformAddCreatorAccount({ phone: cleanPhone(phone), apiId: Number(apiId.trim()), apiHash: apiHash.trim() }),
      );
    });

  if (step) {
    return <LoginSteps first={step} onDone={() => navigate('/platform/bots', { replace: true })} />;
  }
  return (
    <List>
      <ErrorBanner message={actions.error} />
      <Section header={t('creator.addTitle')} footer={t('creator.addFooter')}>
        <Input
          header={t('creator.phone')}
          placeholder="+34600000000"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          status={phone.trim() !== '' && !PHONE_RE.test(cleanPhone(phone)) ? 'error' : 'default'}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Input
          header="api_id"
          inputMode="numeric"
          autoComplete="off"
          value={apiId}
          status={apiId.trim() !== '' && !/^\d+$/.test(apiId.trim()) ? 'error' : 'default'}
          onChange={(e) => setApiId(e.target.value)}
        />
        <Input
          header="api_hash"
          autoComplete="off"
          spellCheck={false}
          value={apiHash}
          status={apiHash.trim() !== '' && !HASH_RE.test(apiHash.trim()) ? 'error' : 'default'}
          onChange={(e) => setApiHash(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button stretched disabled={!valid} onClick={send}>
            {t('creator.sendCode')}
          </Button>
        </div>
      </Section>
    </List>
  );
}

/** The code (and the password, if the account has one) until it is signed in. */
function LoginSteps({ first, onDone }: { first: CreatorLoginStep; onDone: () => void }): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [step, setStep] = useState(first);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  const next = (result: CreatorLoginStep): void => {
    if (result.step === 'done') onDone();
    else setStep(result);
  };

  if (step.step === 'password') {
    return (
      <List>
        <ErrorBanner message={actions.error} />
        <Section
          header={t('creator.passwordTitle')}
          footer={step.hint ? t('creator.passwordHint', { hint: step.hint }) : t('creator.passwordFooter')}
        >
          <Input
            header={t('creator.password')}
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div style={{ padding: 16 }}>
            <Button
              stretched
              disabled={password === ''}
              onClick={() => void actions.run(async () => next(await api.platformCreatorPassword(step.id, password)))}
            >
              {t('creator.signIn')}
            </Button>
          </div>
        </Section>
      </List>
    );
  }
  return (
    <List>
      <ErrorBanner message={actions.error} />
      <Section
        header={t('creator.codeTitle')}
        footer={step.viaApp ? t('creator.codeViaApp') : t('creator.codeViaSms')}
      >
        <Input
          header={t('creator.code')}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            disabled={!/^\d{4,8}$/.test(code.trim())}
            onClick={() => void actions.run(async () => next(await api.platformCreatorCode(step.id, code.trim())))}
          >
            {t('creator.signIn')}
          </Button>
        </div>
      </Section>
    </List>
  );
}

function Account({ id }: { id: number }): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const accounts = useAsync(() => api.platformCreatorAccounts(), [reloadKey]);
  if (accounts.loading && !accounts.data) return <Loader />;
  if (accounts.error) return <ErrorView message={accounts.error} />;
  const account = accounts.data?.find((a) => a.id === id);
  if (!account) return <ErrorView message={t('creator.notFound')} />;
  return <AccountView account={account} onChanged={() => setReloadKey((k) => k + 1)} />;
}

function AccountView({ account, onChanged }: { account: CreatorAccountInfo; onChanged: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const actions = useAdminActions(() => undefined);
  const [step, setStep] = useState<CreatorLoginStep | null>(null);
  const chip = ACCOUNT_CHIP[account.status];

  if (step) {
    return (
      <LoginSteps
        first={step}
        onDone={() => {
          setStep(null);
          onChanged();
        }}
      />
    );
  }
  return (
    <List>
      <ErrorBanner message={actions.error} />
      <Section header={t('creator.account')}>
        <Cell after={<span className={`gb-chip ${chip.className}`}>{t(chip.key)}</span>} subtitle={account.phone}>
          {account.username ? `@${account.username}` : (account.firstName ?? t('creator.unnamed'))}
        </Cell>
        {account.telegramId !== null && <Cell after={String(account.telegramId)}>{t('creator.telegramId')}</Cell>}
        <Cell after={account.checkedAt ? formatDate(account.checkedAt) : '—'}>{t('creator.checkedAt')}</Cell>
        {account.lastError && (
          <Cell multiline subtitle={account.lastError}>
            {t('creator.lastError')}
          </Cell>
        )}
      </Section>
      <Section footer={t('creator.reloginFooter')}>
        <Cell onClick={() => void actions.run(async () => setStep(await api.platformCreatorRelogin(account.id)))}>
          {t('creator.relogin')}
        </Cell>
        <Cell
          onClick={() =>
            void actions.twoTap('remove', async () => {
              await api.platformRemoveCreatorAccount(account.id);
              navigate('/platform/bots', { replace: true });
            })
          }
        >
          <span style={{ color: 'var(--tgui--destructive_text_color, #e53935)' }}>
            {actions.tapLabel('remove', t('creator.remove'))}
          </span>
        </Cell>
      </Section>
    </List>
  );
}
