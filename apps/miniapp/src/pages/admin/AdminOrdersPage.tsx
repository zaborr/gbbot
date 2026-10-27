import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../../components/Field.js';
import type { Order } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useLiveRefresh } from '../../hooks/useLiveRefresh.js';
import { formatPrice } from '../../lib/format.js';
import { itemName } from '../../lib/variants.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { AdminOnly, AdminStatusChip, formatDate, itemsSummary, needsAttention } from './common.js';
import { useShopPath } from '../../providers/ShopProvider.js';
import { t, tn, type MessageKey } from '../../i18n/index.js';

type FilterKey = 'all' | 'attention' | 'unpaid' | 'paid' | 'shipped' | 'fulfilled' | 'cancelled';

const FILTERS: Record<FilterKey, { label: MessageKey; match: (order: Order) => boolean }> = {
  all: { label: 'catalog.all', match: () => true },
  attention: { label: 'adminHome.toReview', match: needsAttention },
  unpaid: { label: 'filter.unpaid', match: (o) => o.status === 'pending' },
  paid: { label: 'filter.toShip', match: (o) => o.status === 'paid' },
  shipped: { label: 'orderStatus.shipped', match: (o) => o.status === 'shipped' },
  fulfilled: { label: 'orderStatus.fulfilled', match: (o) => o.status === 'fulfilled' },
  cancelled: { label: 'orderStatus.cancelled', match: (o) => o.status === 'cancelled' },
};

function isFilterKey(value: string | null): value is FilterKey {
  return value !== null && value in FILTERS;
}

/** All orders with status filters and search; tap one to open its detail. */
export function AdminOrdersPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminOrders />
    </AdminOnly>
  );
}

function AdminOrders(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const [params, setParams] = useSearchParams();
  const filterParam = params.get('filter');
  const filter: FilterKey = isFilterKey(filterParam) ? filterParam : 'all';
  const [search, setSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const orders = useAsync(() => api.adminGetOrders(), [reloadKey]);
  // New orders and payments arrive while away: refresh on return.
  useLiveRefresh(
    () => setReloadKey((k) => k + 1),
    (orders.data ?? []).some((o) => o.paymentCheck?.status === 'checking'),
    10_000,
  );

  if (orders.loading && !orders.data) return <Loader />;
  if (orders.error) return <ErrorView message={orders.error} />;

  const all = orders.data ?? [];
  const query = search.trim().toLowerCase().replace(/^[@#]/, '');
  const visible = all.filter(
    (order) =>
      FILTERS[filter].match(order) &&
      (query === '' ||
        order.id.toLowerCase().startsWith(query) ||
        (order.contactUsername ?? '').toLowerCase().includes(query) ||
        order.items.some((item) => itemName(item).toLowerCase().includes(query))),
  );

  return (
    <List>
      <Section>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
          {(Object.keys(FILTERS) as FilterKey[]).map((key) => {
            const count = all.filter(FILTERS[key].match).length;
            return (
              <Button
                key={key}
                size="s"
                mode={key === filter ? 'filled' : 'bezeled'}
                onClick={() => setParams(key === 'all' ? {} : { filter: key }, { replace: true })}
              >
                {`${t(FILTERS[key].label)} · ${count}`}
              </Button>
            );
          })}
        </div>
        <Input
          header={t('adminOrders.search')}
          placeholder={t('adminOrders.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Section>

      <Section header={tn(visible.length, 'count.orders.one', 'count.orders.other')}>
        {visible.length === 0 && <Cell>{t('adminOrders.empty')}</Cell>}
        {visible.map((order) => (
          <Cell
            key={order.id}
            onClick={() => navigate(to(`/admin/orders/${order.id}`))}
            subtitle={formatDate(order.createdAt)}
            description={
              <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span>{itemsSummary(order)}</span>
                <span className="gb-chips">
                  <AdminStatusChip order={order} />
                  {order.customerBlocked && (
                    <span className="gb-chip gb-chip--warn">{t('blacklist.badge')}</span>
                  )}
                </span>
              </span>
            }
            after={formatPrice(order.total, order.currency)}
            multiline
          >
            {`#${order.id.slice(0, 8)}${order.contactUsername ? ` · @${order.contactUsername}` : ''}`}
          </Cell>
        ))}
      </Section>
    </List>
  );
}
