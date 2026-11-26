import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../../components/Field.js';
import { goodsStatus, type Order } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useLiveRefresh } from '../../hooks/useLiveRefresh.js';
import { formatPrice } from '../../lib/format.js';
import { itemName } from '../../lib/variants.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { AdminOnly, AdminStatusChip, formatDate, itemsSummary, needsAttention } from './common.js';
import { useShopPath } from '../../providers/ShopProvider.js';
import { CopyOrders } from '../../components/CopyOrders.js';
import { LabelRequestsSection, labelMissing } from '../../components/OrderLabel.js';
import { t, tn, type MessageKey } from '../../i18n/index.js';

type FilterKey = 'all' | 'attention' | 'unpaid' | 'paid' | 'label' | 'shipped' | 'fulfilled' | 'cancelled' | 'testing';

const FILTERS: Record<FilterKey, { label: MessageKey; match: (order: Order) => boolean }> = {
  all: { label: 'catalog.all', match: () => true },
  attention: { label: 'adminHome.toReview', match: needsAttention },
  // By where the products are: paid ones owing only a donation are not "unpaid".
  unpaid: { label: 'filter.unpaid', match: (o) => goodsStatus(o) === 'pending' },
  // From outside: nothing to send.
  paid: { label: 'filter.toShip', match: (o) => goodsStatus(o) === 'paid' && !o.external },
  // Asked for a shipping label that has not arrived.
  label: { label: 'label.filter', match: labelMissing },
  shipped: { label: 'orderStatus.shipped', match: (o) => goodsStatus(o) === 'shipped' },
  fulfilled: { label: 'orderStatus.fulfilled', match: (o) => goodsStatus(o) === 'fulfilled' },
  cancelled: { label: 'orderStatus.cancelled', match: (o) => o.status === 'cancelled' },
  // Taking part in a testing (from outside too).
  testing: { label: 'testing.title', match: (o) => (o.testings?.length ?? 0) > 0 || o.external },
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
            // Testing only in GBs with some.
            if (key === 'testing' && count === 0 && filter !== 'testing') return null;
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

      <Section>
        <Cell onClick={() => navigate(to('/admin/orders/new'))}>{t('adminCreate.open')}</Cell>
      </Section>

      <LabelRequestsSection orders={all} onDone={() => setReloadKey((k) => k + 1)} />

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
                  {(order.testings ?? []).map((x) => (
                    <span key={x.id} className="gb-chip gb-chip--info">{`🧪 ${x.label}`}</span>
                  ))}
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

      {/* What is shown (filter and search), as a table for Excel. */}
      <CopyOrders key={`${filter}|${query}`} orders={visible} several />
    </List>
  );
}
