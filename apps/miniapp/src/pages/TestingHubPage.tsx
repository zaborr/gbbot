import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { awaitsPayment, type Order, type Testing } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { formatPrice } from '../lib/format.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { PageTitle } from '../components/PageTitle.js';
import { TestingCard } from '../components/TestingCard.js';
import { TestingsInProgress } from '../components/TestingsInProgress.js';
import { DonationSection, ExtraSection, VolunteerSection } from '../components/TestingOrderSections.js';
import { useShopPath } from '../providers/ShopProvider.js';
import { t } from '../i18n/index.js';

const nameOf = (x: Testing): string => (x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle);

/** Done with: settled or cancelled. */
const finished = (x: Testing): boolean => x.status === 'settled' || x.status === 'cancelled';

/**
 * Everything about testings, apart from orders: those one is in (how far,
 * what is left to pay, the vial, giving, the extra round, the report), those
 * one can still join, and those finished.
 */
export function TestingHubPage(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const [reloadKey, setReloadKey] = useState(0);
  const [joinedNow, setJoinedNow] = useState<string | null>(null);
  const testings = useAsync(() => api.getTestings(), [reloadKey]);
  const orders = useAsync(() => api.getOrders(), [reloadKey]);
  const reload = (): void => setReloadKey((k) => k + 1);

  if ((testings.loading && !testings.data) || (orders.loading && !orders.data)) return <Loader />;
  if (testings.error) return <ErrorView message={testings.error} />;
  if (orders.error) return <ErrorView message={orders.error} />;
  const all = testings.data ?? [];
  const mine = orders.data ?? [];

  /** The order they take part with: from outside for it, or one with the product. */
  const orderFor = (x: Testing): Order | undefined =>
    mine.find((o) => o.externalTestingId === x.id && o.status !== 'cancelled') ??
    mine.find(
      (o) =>
        o.status !== 'cancelled' &&
        o.items.some((i) => i.productId === x.productId && (x.variantId === null || i.variantId === x.variantId)),
    );

  const inNow = all.filter((x) => x.joined && !finished(x));
  const done = all.filter((x) => x.joined && finished(x));
  const nothing = inNow.length === 0 && done.length === 0;

  return (
    <List>
      <PageTitle title={t('testingHub.title')} />

      {joinedNow && (
        <Section>
          <Cell multiline>{t('testing.joinedBanner', { product: joinedNow })}</Cell>
        </Section>
      )}

      {inNow.map((x) => {
        const order = orderFor(x);
        return (
          <div key={x.id}>
            <TestingCard testing={x} title={nameOf(x)}>
              {order && <MyPlace order={order} onPay={() => navigate(to(`/orders/${order.id}`))} />}
              {/* The vial is this testing's: its switch lives in its card. */}
              {order && <VolunteerSection order={order} only={x.id} testings={all} inCard onChanged={reload} />}
            </TestingCard>
            {order && (
              <>
                <DonationSection order={order} only={x.id} testings={all} onChanged={reload} />
                <ExtraSection order={order} only={x.id} testings={all} onChanged={reload} />
              </>
            )}
          </div>
        );
      })}

      <TestingsInProgress
        orders={mine}
        testings={all}
        onOrder={(id) => navigate(to(`/orders/${id}`))}
        onJoined={(name) => {
          setJoinedNow(name);
          reload();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onChanged={reload}
      />

      {done.length > 0 && (
        <Section header={t('testingHub.finished')}>
          {done.map((x) => (
            <Cell
              key={x.id}
              multiline
              subtitle={
                x.status === 'cancelled'
                  ? t('testingHub.cancelled')
                  : x.reportSentAt
                    ? t('testingHub.reportSent')
                    : t('testingHub.settled')
              }
            >
              {nameOf(x)}
            </Cell>
          ))}
        </Section>
      )}

      {nothing && !all.some((x) => !x.joined && !finished(x)) && (
        <Placeholder header={t('testingHub.empty')} description={t('testingHub.emptyHint')}>
          <span style={{ fontSize: 48 }}>🧪</span>
        </Placeholder>
      )}
    </List>
  );
}

/** Where this person stands: in, or with something to pay first (then to the order). */
function MyPlace({ order, onPay }: { order: Order; onPay: () => void }): React.JSX.Element {
  if (awaitsPayment(order)) {
    return (
      <Cell
        multiline
        subtitle={t('testingHub.toPayHint')}
        after={
          <Button size="s" onClick={onPay}>
            {t('testingHub.pay')}
          </Button>
        }
      >
        {t('testingHub.toPay', { amount: formatPrice(order.amountDue, order.currency) })}
      </Cell>
    );
  }
  if (order.amountSubmitted > 0 && order.status !== 'paid') {
    return <Cell multiline>{t('testingHub.checking')}</Cell>;
  }
  return <Cell multiline>{t('testingHub.in')}</Cell>;
}
