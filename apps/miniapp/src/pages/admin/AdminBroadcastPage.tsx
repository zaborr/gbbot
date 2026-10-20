import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { BROADCAST_MAX_LENGTH, broadcastAudience, type BroadcastAudience } from '@tma-shop/shared';
import { Textarea } from '../../components/Field.js';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useLiveRefresh } from '../../hooks/useLiveRefresh.js';
import { useShop } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { locale, t, type MessageKey } from '../../i18n/index.js';

/** A message to the GB's buyers, sent by the bot; with the history of earlier ones. */
export function AdminBroadcastPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <Broadcast />
    </AdminOnly>
  );
}

const audienceLabel = (audience: BroadcastAudience): string =>
  t(`broadcast.audience.${audience}` as MessageKey);

function Broadcast(): React.JSX.Element {
  const { shop } = useShop();
  const [audience, setAudience] = useState<BroadcastAudience>('orders');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));
  const count = useAsync(() => api.adminBroadcastCount(audience), [audience, reloadKey]);
  const history = useAsync(() => api.adminListBroadcasts(), [reloadKey]);
  const sending = (history.data ?? []).some((b) => b.status === 'sending');
  // Follow a send in progress.
  useLiveRefresh(() => setReloadKey((k) => k + 1), sending, 3000);

  const recipients = count.data?.count ?? 0;
  const message = text.trim();

  const send = async (): Promise<void> => {
    setBusy(true);
    await actions.twoTap('send', async () => {
      await api.adminSendBroadcast(audience, message);
      setText('');
      setSent(true);
    });
    setBusy(false);
  };

  return (
    <List>
      <PageTitle title={t('broadcast.title')} />
      <ErrorBanner message={actions.error} />

      <Section header={t('broadcast.to')} footer={t('broadcast.toFooter')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 16px' }}>
          {broadcastAudience.options.map((option) => (
            <Button
              key={option}
              size="s"
              mode={audience === option ? 'filled' : 'bezeled'}
              onClick={() => {
                setAudience(option);
                setSent(false);
              }}
            >
              {audienceLabel(option)}
            </Button>
          ))}
        </div>
        <Cell after={count.loading ? '…' : String(recipients)}>{t('broadcast.people')}</Cell>
      </Section>

      <Section
        header={t('broadcast.message')}
        footer={t('broadcast.messageFooter', { shop: shop.name, count: message.length, max: BROADCAST_MAX_LENGTH })}
      >
        <Textarea
          header={t('broadcast.text')}
          placeholder={t('broadcast.placeholder')}
          maxLength={BROADCAST_MAX_LENGTH}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSent(false);
          }}
        />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={message === '' || recipients === 0}
            onClick={() => void send()}
          >
            {actions.tapLabel(
              'send',
              t('broadcast.send', { count: recipients }),
              t('broadcast.sendConfirm', { count: recipients }),
            )}
          </Button>
        </div>
        {sent && <Cell multiline>{t('broadcast.sending')}</Cell>}
      </Section>

      {(history.data ?? []).length > 0 && (
        <Section header={t('broadcast.history')}>
          {(history.data ?? []).map((b) => (
            <Cell
              key={b.id}
              multiline
              subtitle={[
                new Date(b.createdAt).toLocaleString(locale(), {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
                audienceLabel(b.audience),
                b.sender,
              ].join(' · ')}
              description={
                b.status === 'sending'
                  ? t('broadcast.inProgress', { sent: b.sent, total: b.recipients })
                  : t('broadcast.result', { sent: b.sent, total: b.recipients, failed: b.failed })
              }
            >
              {b.text.length > 140 ? `${b.text.slice(0, 140)}…` : b.text}
            </Cell>
          ))}
        </Section>
      )}
    </List>
  );
}
