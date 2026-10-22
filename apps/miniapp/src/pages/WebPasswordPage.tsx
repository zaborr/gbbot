import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { api, ApiClientError } from '../api/client.js';
import { useSession } from '../providers/SessionProvider.js';
import { PageTitle } from '../components/PageTitle.js';
import { Input } from '../components/Field.js';
import { t } from '../i18n/index.js';

const MIN_LENGTH = 12;

/** Web mode: the signed-in account changes its own password. */
export function WebPasswordPage(): React.JSX.Element {
  const { replaceWebToken } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = repeat.length > 0 && repeat !== next;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.changeWebPassword(current, next);
      replaceWebToken(session.token, session.expiresAt);
      setDone(true);
      setCurrent('');
      setNext('');
      setRepeat('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('error.title'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <List>
      <PageTitle title={t('webPassword.title')} />
      {done && (
        <Section>
          <Cell multiline>{t('webPassword.done')}</Cell>
        </Section>
      )}
      <Section footer={error ?? (mismatch ? t('webPassword.mismatch') : t('webPassword.footer'))}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Input
            header={t('webPassword.current')}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Input
            header={t('webPassword.next')}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <Input
            header={t('webPassword.repeat')}
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
          <Button
            stretched
            loading={busy}
            disabled={!current || next.length < MIN_LENGTH || next !== repeat}
            onClick={() => void submit()}
          >
            {t('webPassword.save')}
          </Button>
        </div>
      </Section>
    </List>
  );
}
