import { useState } from 'react';
import { Button, List, Section } from '@telegram-apps/telegram-ui';
import { api, ApiClientError } from '../api/client.js';
import { Input } from './Field.js';
import { PageTitle } from './PageTitle.js';
import { SnakeGame } from './SnakeGame.js';
import { AccountSections } from './WebAccount.js';
import { t } from '../i18n/index.js';

/**
 * Private mode, in Telegram: someone who is not in enters their invitation and
 * makes their web account at once (Telegram already says who they are); a
 * member past the deadline makes their web account. And a game meanwhile.
 */
export function PrivateGate({ kind }: { kind: 'invite' | 'account' }): React.JSX.Element {
  return (
    <List>
      <PageTitle title={t('gate.title')} />
      {kind === 'invite' ? <JoinWithInvite /> : <MakeAccountFirst />}
      <Section header={t('gate.meanwhile')}>
        <SnakeGame />
      </Section>
    </List>
  );
}

function JoinWithInvite(): React.JSX.Element {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mismatch = password !== '' && again !== '' && password !== again;
  const ready = code.trim().length >= 8 && username.trim().length >= 3 && password.length >= 10 && password === again;
  return (
    <Section header={t('gate.invite')} footer={note ?? (mismatch ? t('acct.passwordsDiffer') : t('gate.inviteFooter'))}>
      <Input
        header={t('acct.inviteCode')}
        placeholder="river-XXXXX-XXXXX-XXXXX-sage"
        autoCapitalize="none"
        autoComplete="off"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Input header={t('acct.username')} autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input header={t('acct.password')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Input header={t('acct.passwordAgain')} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      <div style={{ padding: 16 }}>
        <Button
          stretched
          loading={busy}
          disabled={!ready}
          onClick={() => {
            setBusy(true);
            setNote(null);
            void api
              .joinWithInvite({ code: code.trim(), username: username.trim(), password })
              .then(() => window.location.reload())
              .catch((err: unknown) => setNote(err instanceof ApiClientError ? err.message : t('error.title')))
              .finally(() => setBusy(false));
          }}
        >
          {t('gate.enter')}
        </Button>
      </div>
    </Section>
  );
}

function MakeAccountFirst(): React.JSX.Element {
  return (
    <>
      <Section>
        <div style={{ padding: 16 }} className="gb-hint">
          {t('gate.accountNeeded')}
        </div>
      </Section>
      <AccountSections inTelegram onCreated={() => window.location.reload()} />
    </>
  );
}
