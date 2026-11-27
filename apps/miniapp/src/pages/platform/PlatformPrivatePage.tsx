import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { api, ApiClientError } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { formatDateTime } from '../../lib/format.js';
import { t } from '../../i18n/index.js';

const REASONS = [
  ['staff', 'private.reason.staff'],
  ['account', 'private.reason.account'],
  ['key', 'private.reason.key'],
  ['list', 'private.reason.list'],
  ['orders', 'private.reason.orders'],
] as const;

/**
 * Platform super-admin: private mode (only members see the GBs), with a look
 * at who would be in before switching it on, and the deadline for members to
 * have made their web account.
 */
export function PlatformPrivatePage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  const [reloadKey, setReloadKey] = useState(0);
  const current = useAsync(() => api.platformPrivate(), [reloadKey]);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.platformPrivatePreview>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  if (current.loading && !current.data) return <Loader />;
  if (current.error || !current.data) return <ErrorView message={current.error ?? t('error.title')} />;
  const { privateMode, accountDeadline } = current.data;

  const run = (what: string, work: () => Promise<unknown>): void => {
    setBusy(what);
    setNote(null);
    void work()
      .then(() => setReloadKey((k) => k + 1))
      .catch((err: unknown) => setNote(err instanceof ApiClientError ? err.message : t('error.title')))
      .finally(() => setBusy(null));
  };

  return (
    <List>
      <PageTitle title={t('private.title')} />
      <Section footer={note ?? t('private.footer')}>
        <Cell subtitle={privateMode ? t('private.onHint') : t('private.offHint')}>
          {privateMode ? t('private.on') : t('private.off')}
        </Cell>
        <div style={{ padding: 16 }}>
          {privateMode ? (
            <Button stretched mode="bezeled" loading={busy === 'mode'} onClick={() => run('mode', () => api.platformSetPrivate({ privateMode: false }))}>
              {t('private.turnOff')}
            </Button>
          ) : (
            <Button
              stretched
              loading={busy === 'mode'}
              disabled={!preview}
              onClick={() => {
                if (!sure) {
                  setSure(true);
                  return;
                }
                setSure(false);
                run('mode', () => api.platformSetPrivate({ privateMode: true }));
              }}
            >
              {sure ? t('private.turnOnSure', { n: preview?.total ?? 0 }) : t('private.turnOn')}
            </Button>
          )}
        </div>
      </Section>

      <Section header={t('private.previewTitle')} footer={t('private.previewFooter')}>
        {preview ? (
          <>
            <Cell after={String(preview.total)}>{t('private.total')}</Cell>
            {REASONS.map(([r, label]) => (
              <Cell key={r} after={String(preview.byReason[r] ?? 0)}>
                {t(label)}
              </Cell>
            ))}
          </>
        ) : (
          <div style={{ padding: 16 }}>
            <Button
              stretched
              mode="bezeled"
              loading={busy === 'preview'}
              onClick={() => {
                setBusy('preview');
                void api
                  .platformPrivatePreview()
                  .then(setPreview)
                  .catch((err: unknown) => setNote(err instanceof ApiClientError ? err.message : t('error.title')))
                  .finally(() => setBusy(null));
              }}
            >
              {t('private.preview')}
            </Button>
          </div>
        )}
      </Section>
      {preview && preview.onlyOrders.length > 0 && (
        <Section header={t('private.onlyOrders', { n: preview.onlyOrders.length })} footer={t('private.onlyOrdersFooter')}>
          {preview.onlyOrders.map((p) => (
            <Cell key={p.telegramId} subtitle={String(p.telegramId)}>
              {p.name}
            </Cell>
          ))}
        </Section>
      )}

      <Section header={t('private.deadlineTitle')} footer={t('private.deadlineFooter')}>
        <Cell>{accountDeadline ? t('private.deadlineOn', { date: formatDateTime(accountDeadline) }) : t('private.deadlineNone')}</Cell>
        <div style={{ display: 'flex', gap: 8, padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            loading={busy === 'none'}
            disabled={accountDeadline === null}
            onClick={() => run('none', () => api.platformSetPrivate({ accountDeadline: null }))}
          >
            {t('private.deadlineRemove')}
          </Button>
          <Button
            stretched
            loading={busy === 'set'}
            onClick={() =>
              run('set', () => api.platformSetPrivate({ accountDeadline: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() }))
            }
          >
            {t('private.deadline30')}
          </Button>
        </div>
      </Section>
    </List>
  );
}
