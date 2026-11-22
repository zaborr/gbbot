import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { BROADCAST_MAX_LENGTH } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { formatPrice } from '../../lib/format.js';
import { lineName } from '../../lib/variants.js';
import { Textarea } from '../../components/Field.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { OrderStatusChip } from '../../components/OrderStatus.js';
import { useShopPath } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, itemsSummary, useAdminActions } from './common.js';
import { t, tn } from '../../i18n/index.js';

/** One buyer of the GB: what they have, their cart, orders and testings, and a message to them. */
export function AdminBuyerPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminBuyer />
    </AdminOnly>
  );
}

function AdminBuyer(): React.JSX.Element {
  const { userId } = useParams();
  const id = Number(userId);
  const navigate = useNavigate();
  const to = useShopPath();
  const buyer = useAsync(() => api.adminGetBuyer(id), [id]);
  const [reach, setReach] = useState<boolean | null>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<boolean | null>(null);
  const actions = useAdminActions(() => undefined);

  if (buyer.loading && !buyer.data) return <Loader />;
  if (buyer.error || !buyer.data) return <ErrorView message={buyer.error ?? t('buyers.none')} />;
  const b = buyer.data;
  const fmt = (amount: number): string => formatPrice(amount, b.currency);
  const message = text.trim();

  return (
    <List>
      <PageTitle title={b.name} />
      <ErrorBanner message={actions.error} />

      <Section>
        <Cell
          multiline
          subtitle={[
            b.username ? `@${b.username}` : t('buyers.noUsername'),
            `id ${b.telegramId}`,
            b.vip ? 'VIP' : null,
            b.blocked ? t('blacklist.badge') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          after={
            b.username ? (
              <a href={`https://t.me/${b.username}`} target="_blank" rel="noreferrer">
                {t('buyers.openChat')}
              </a>
            ) : undefined
          }
        >
          <strong>{b.name}</strong>
        </Cell>
        <Cell after={fmt(b.paid)}>{t('buyers.paidTotal')}</Cell>
        {b.owed > 0 && <Cell after={fmt(b.owed)}>{t('buyers.owedTotal')}</Cell>}
      </Section>

      <Section header={t('buyers.has', { count: b.units })} footer={t('buyers.hasFooter')}>
        {b.products.length === 0 && <Cell multiline>{t('buyers.nothingOrdered')}</Cell>}
        {b.products.map((p) => (
          <Cell
            key={p.key}
            multiline
            after={String(p.unpaid + p.paid + p.shipped)}
            subtitle={[
              p.shipped > 0 ? t('buyers.shipped', { count: p.shipped }) : null,
              p.paid > 0 ? t('buyers.paidToSend', { count: p.paid }) : null,
              p.unpaid > 0 ? t('buyers.unpaidUnits', { count: p.unpaid }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            {lineName(p.title, p.variantLabel)}
          </Cell>
        ))}
      </Section>

      {b.cart.length > 0 && (
        <Section header={tn(b.cartUnits, 'buyers.inCart.one', 'buyers.inCart.other')} footer={t('buyers.cartFooter')}>
          {b.cart.map((line, index) => (
            <Cell key={index} after={String(line.quantity)}>
              {lineName(line.title, line.variantLabel)}
            </Cell>
          ))}
        </Section>
      )}

      {b.orderList.length > 0 && (
        <Section header={tn(b.orderList.length, 'buyers.orders.one', 'buyers.orders.other')}>
          {b.orderList.map((order) => (
            <Cell
              key={order.id}
              onClick={() => navigate(to(`/admin/orders/${order.id}`))}
              multiline
              subtitle={order.external ? t('orders.externalTesting') : itemsSummary(order)}
              after={
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <span>{formatPrice(order.total, order.currency)}</span>
                  <OrderStatusChip order={order} />
                </span>
              }
            >
              {t('orders.orderNumber', { id: order.id.slice(0, 8) })}
            </Cell>
          ))}
        </Section>
      )}

      {b.testings.length > 0 && (
        <Section header={t('testing.title')}>
          {b.testings.map((x) => (
            <Cell
              key={x.id}
              onClick={() => navigate(to(`/admin/testings/${x.id}`))}
              multiline
              subtitle={[
                x.paid ? t('testing.paid') : t('testing.unpaid'),
                x.volunteer ? t('testing.volunteerChip') : null,
                x.donor ? t('testing.orders.donorChip') : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {x.label}
            </Cell>
          ))}
        </Section>
      )}

      <Section header={t('buyers.messageTitle')} footer={t('buyers.messageFooter')}>
        <Cell
          multiline
          after={
            <Button
              size="s"
              mode="bezeled"
              onClick={() => void actions.run(async () => setReach((await api.adminBuyerReach(b.telegramId)).reachable))}
            >
              {t('buyers.check')}
            </Button>
          }
        >
          {reach === null ? t('buyers.reachUnknown') : reach ? t('buyers.reachYes') : t('buyers.reachNo')}
        </Cell>
        <Textarea
          header={t('broadcast.text')}
          maxLength={BROADCAST_MAX_LENGTH}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSent(null);
          }}
        />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            disabled={message === ''}
            onClick={() =>
              void actions.run(async () => {
                const result = await api.adminMessageBuyer(b.telegramId, message);
                setSent(result.sent);
                if (result.sent) setText('');
              })
            }
          >
            {t('buyers.send')}
          </Button>
        </div>
        {sent !== null && <Cell multiline>{sent ? t('buyers.sent') : t('buyers.notSent')}</Cell>}
      </Section>
    </List>
  );
}
