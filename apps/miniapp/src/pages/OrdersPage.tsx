import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import type { OrderStatus } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useLiveRefresh } from '../hooks/useLiveRefresh.js';
import { formatPrice } from '../lib/format.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { useShopPath } from '../providers/ShopProvider.js';
import { t, tn, type MessageKey } from '../i18n/index.js';

/** Order status as the customer sees it. */
function statusText(status: OrderStatus): string {
  const keys: Record<OrderStatus, MessageKey> = {
    pending: 'orderStatus.pending',
    awaiting_payment: 'orderStatus.awaiting_payment',
    paid: 'orderStatus.paid',
    cancelled: 'orderStatus.cancelled',
    shipped: 'orderStatus.shipped',
    fulfilled: 'orderStatus.fulfilled',
  };
  return t(keys[status]);
}

/** Customers can delete orders with nothing paid or under verification. */
const DELETABLE: OrderStatus[] = ['pending', 'cancelled'];

export function OrdersPage(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const [reloadKey, setReloadKey] = useState(0);
  const { data: orders, loading, error } = useAsync(() => api.getOrders(), [reloadKey]);
  const [armed, setArmed] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Statuses change while away (payment confirmed, shipped…): refresh on return.
  useLiveRefresh(
    () => setReloadKey((k) => k + 1),
    (orders ?? []).some((o) => o.paymentCheck?.status === 'checking'),
  );

  // Two taps: the first arms the button, the second deletes.
  const remove = async (orderId: string): Promise<void> => {
    if (armed !== orderId) {
      setArmed(orderId);
      return;
    }
    setArmed(null);
    setDeleteError(null);
    try {
      await api.deleteOrder(orderId);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setDeleteError(err instanceof ApiClientError ? err.message : t('orders.deleteFailed'));
    }
  };

  if (loading && !orders) return <Loader />;
  if (error) return <ErrorView message={error} />;
  if (!orders || orders.length === 0) {
    return (
      <Placeholder header={t('orders.empty')} description={t('orders.emptyHint')}>
        <span style={{ fontSize: 48 }}>📦</span>
      </Placeholder>
    );
  }

  return (
    <List>
      {deleteError && (
        <Section>
          <Cell multiline style={{ color: 'var(--tgui--destructive_text_color)' }}>
            {deleteError}
          </Cell>
        </Section>
      )}
      <Section header={t('orders.title')}>
        {orders.map((order) => (
          <Cell
            key={order.id}
            onClick={() => navigate(to(`/orders/${order.id}`))}
            subtitle={tn(order.items.length, 'items.one', 'items.other')}
            after={formatPrice(order.total, order.currency)}
            description={
              DELETABLE.includes(order.status) &&
              order.amountPaid === 0 &&
              order.amountSubmitted === 0 ? (
                <Button
                  size="s"
                  mode="plain"
                  onClick={(event) => {
                    // The cell itself opens the order; don't navigate on delete.
                    event.stopPropagation();
                    void remove(order.id);
                  }}
                >
                  {armed === order.id ? t('common.tapAgainToDelete') : t('common.delete')}
                </Button>
              ) : (
                <Badge type="dot" />
              )
            }
            hint={
              order.changeRequest
                ? t('orders.changeRequested')
                : order.status === 'pending' && order.amountPaid > 0
                  ? t('orders.differenceToPay')
                  : statusText(order.status)
            }
            multiline
          >
            {t('orders.orderNumber', { id: order.id.slice(0, 8) })}
          </Cell>
        ))}
      </Section>
    </List>
  );
}
