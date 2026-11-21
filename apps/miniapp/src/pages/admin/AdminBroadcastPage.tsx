import { useEffect, useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import {
  BROADCAST_MAX_LENGTH,
  broadcastAudience,
  TESTING_AUDIENCES,
  type BroadcastAudience,
  type ReachResult,
  type UnreachedPerson,
} from '@tma-shop/shared';
import { copyText } from '../../lib/clipboard.js';
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
  // For a testing's audiences: which one (those not cancelled).
  const testings = useAsync(
    () => (shop.testingEnabled ? api.adminGetTestings() : Promise.resolve([])),
    [shop.testingEnabled],
  );
  const live = (testings.data ?? []).filter((x) => x.status !== 'cancelled');
  const [testingId, setTestingId] = useState<string | null>(null);
  const aboutTesting = TESTING_AUDIENCES.includes(audience);
  const chosen = aboutTesting ? (testingId ?? live[0]?.id ?? null) : null;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [check, setCheck] = useState<{ id: string; result: ReachResult | null } | null>(null);
  const [checkCopied, setCheckCopied] = useState(false);
  // Follow the check until it is done.
  useEffect(() => {
    if (!check || check.result?.done) return;
    const timer = setTimeout(() => {
      api
        .adminReachStatus(check.id)
        .then((result) => setCheck((now) => (now?.id === check.id ? { id: check.id, result } : now)))
        .catch(() => setCheck(null));
    }, 1500);
    return () => clearTimeout(timer);
  }, [check]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));
  const count = useAsync(
    () =>
      aboutTesting && !chosen ? Promise.resolve({ count: 0 }) : api.adminBroadcastCount(audience, chosen),
    [audience, chosen, reloadKey],
  );
  const history = useAsync(() => api.adminListBroadcasts(), [reloadKey]);
  const sending = (history.data ?? []).some((b) => b.status === 'sending');
  // Follow a send in progress.
  useLiveRefresh(() => setReloadKey((k) => k + 1), sending, 3000);

  const recipients = count.data?.count ?? 0;
  const message = text.trim();

  const send = async (): Promise<void> => {
    setBusy(true);
    await actions.twoTap('send', async () => {
      await api.adminSendBroadcast(audience, message, chosen);
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
          {broadcastAudience.options
            .filter((option) => shop.testingEnabled || !TESTING_AUDIENCES.includes(option))
            .map((option) => (
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
        {aboutTesting &&
          (live.length === 0 ? (
            <Cell multiline>{t('broadcast.noTesting')}</Cell>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 16px 12px' }}>
              {live.map((x) => (
                <Button
                  key={x.id}
                  size="s"
                  mode={chosen === x.id ? 'filled' : 'bezeled'}
                  onClick={() => {
                    setTestingId(x.id);
                    setSent(false);
                  }}
                >
                  {x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle}
                </Button>
              ))}
            </div>
          ))}
        <Cell after={count.loading ? '…' : String(recipients)}>{t('broadcast.people')}</Cell>
        {recipients > 0 && (
          <div style={{ padding: '0 16px 12px' }}>
            <Button
              size="s"
              mode="bezeled"
              disabled={check !== null && !check.result?.done}
              onClick={() =>
                void actions.run(async () => {
                  const started = await api.adminCheckReach(audience, chosen);
                  setCheckCopied(false);
                  setCheck({ id: started.id, result: { total: started.checking, checked: 0, done: false, unreached: [] } });
                })
              }
            >
              {t('broadcast.reach')}
            </Button>
          </div>
        )}
        {check?.result && !check.result.done && (
          <Cell multiline>{t('broadcast.reachProgress', { checked: check.result.checked, total: check.result.total })}</Cell>
        )}
        {check?.result?.done && (
          <Cell
            multiline
            description={
              check.result.unreached.length > 0 ? (
                <span style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  <span>{check.result.unreached.map(personLabel).join(', ')}</span>
                  <span>
                    <Button
                      size="s"
                      mode="bezeled"
                      onClick={() =>
                        void copyText((check.result?.unreached ?? []).map(personLabel).join('\n')).then(setCheckCopied)
                      }
                    >
                      {checkCopied ? t('sheet.copied') : t('broadcast.copyUnreached')}
                    </Button>
                  </span>
                </span>
              ) : undefined
            }
          >
            {check.result.unreached.length > 0
              ? t('broadcast.reachResult', { count: check.result.unreached.length, total: check.result.total })
              : t('broadcast.reachAll', { total: check.result.total })}
          </Cell>
        )}
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
                b.testing ? `${audienceLabel(b.audience)} (${b.testing})` : audienceLabel(b.audience),
                b.sender,
              ].join(' · ')}
              description={
                <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span>
                    {b.status === 'sending'
                      ? t('broadcast.inProgress', { sent: b.sent, total: b.recipients })
                      : t('broadcast.result', { sent: b.sent, total: b.recipients, failed: b.failed })}
                  </span>
                  {b.status === 'done' && b.unreached.length > 0 && (
                    <>
                      <span>{t('broadcast.unreached', { list: b.unreached.map(personLabel).join(', ') })}</span>
                      <span>
                        <Button
                          size="s"
                          mode="bezeled"
                          onClick={() =>
                            void copyText(b.unreached.map(personLabel).join('\n')).then((ok) =>
                              setCopiedId(ok ? b.id : null),
                            )
                          }
                        >
                          {copiedId === b.id ? t('sheet.copied') : t('broadcast.copyUnreached')}
                        </Button>
                      </span>
                    </>
                  )}
                </span>
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

/** "@ana", or "Ana (no username, order #1a2b3c4d)". */
function personLabel(person: UnreachedPerson): string {
  if (person.username) return `@${person.username}`;
  return person.orderRef ? t('broadcast.unreachedOrder', { name: person.name, ref: person.orderRef }) : person.name;
}
