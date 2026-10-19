import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { isSaleStatus, type Order } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { copyText } from '../../lib/clipboard.js';
import { formatPrice } from '../../lib/format.js';
import { itemKey, itemName } from '../../lib/variants.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { AdminOnly, formatDate, itemsSummary, statusLabel } from './common.js';
import { useShopPath } from '../../providers/ShopProvider.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t, tn, type MessageKey } from '../../i18n/index.js';

type Scope = 'all' | 'toFulfil' | 'shipped' | 'fulfilled';

const SCOPES: Record<Scope, { label: MessageKey; match: (order: Order) => boolean }> = {
  all: { label: 'summary.allPaid', match: (o) => isSaleStatus(o.status) },
  toFulfil: { label: 'filter.toShip', match: (o) => o.status === 'paid' },
  shipped: { label: 'orderStatus.shipped', match: (o) => o.status === 'shipped' },
  fulfilled: { label: 'orderStatus.fulfilled', match: (o) => o.status === 'fulfilled' },
};

interface ProductTotal {
  key: string;
  productId: string;
  title: string;
  currency: string;
  quantity: number;
  revenue: number;
  orders: number;
}

interface CurrencyTotal {
  currency: string;
  orders: number;
  items: number;
  revenue: number;
  fees: number;
  shipping: number;
}

/** Totals per product (and per currency) over the selected paid orders. */
function summarize(orders: Order[]): { products: ProductTotal[]; currencies: CurrencyTotal[] } {
  const products = new Map<string, ProductTotal>();
  const currencies = new Map<string, CurrencyTotal>();

  for (const order of orders) {
    const cur = currencies.get(order.currency) ?? {
      currency: order.currency,
      orders: 0,
      items: 0,
      revenue: 0,
      fees: 0,
      shipping: 0,
    };
    cur.orders += 1;
    cur.revenue += order.total;
    cur.fees += order.fee;
    cur.shipping += order.shipping;

    for (const item of order.items) {
      const key = `${itemKey(item)}:${order.currency}`;
      const row = products.get(key) ?? {
        key,
        productId: item.productId,
        title: itemName(item),
        currency: order.currency,
        quantity: 0,
        revenue: 0,
        orders: 0,
      };
      row.quantity += item.quantity;
      row.revenue += item.subtotal;
      row.orders += 1;
      products.set(key, row);
      cur.items += item.quantity;
    }
    currencies.set(order.currency, cur);
  }

  return {
    products: [...products.values()].sort((a, b) => b.quantity - a.quantity),
    currencies: [...currencies.values()],
  };
}

/** Plain-text version of the summary, to paste anywhere. */
function summaryText(
  label: string,
  products: ProductTotal[],
  currencies: CurrencyTotal[],
  orders: Order[],
): string {
  const lines = [t('summary.textTitle', { label }), ''];
  for (const c of currencies) {
    lines.push(
      `${c.currency}: ${tn(c.orders, 'count.orders.one', 'count.orders.other')}, ` +
        `${tn(c.items, 'items.one', 'items.other')}, ${formatPrice(c.revenue, c.currency)}` +
        (c.fees > 0 ? ` (${t('summary.fees', { amount: formatPrice(c.fees, c.currency) })})` : '') +
        (c.shipping > 0
          ? ` (${t('summary.shipping', { amount: formatPrice(c.shipping, c.currency) })})`
          : ''),
    );
  }
  lines.push('', t('summary.productsColon'));
  for (const p of products) {
    lines.push(`• ${p.quantity}× ${p.title} — ${formatPrice(p.revenue, p.currency)}`);
  }
  lines.push('', t('summary.ordersColon'));
  for (const o of orders) {
    lines.push(
      `• #${o.id.slice(0, 8)}${o.contactUsername ? ` @${o.contactUsername}` : ''} — ` +
        `${formatPrice(o.total, o.currency)} — ${itemsSummary(o)}`,
    );
  }
  return lines.join('\n');
}

/** Sales summary: what was sold across all paid orders, plus the list of those orders. */
export function AdminSummaryPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminSummary />
    </AdminOnly>
  );
}

function AdminSummary(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const [scope, setScope] = useState<Scope>('all');
  const [copied, setCopied] = useState(false);
  const orders = useAsync(() => api.adminGetOrders(), []);

  if (orders.loading) return <Loader />;
  if (orders.error) return <ErrorView message={orders.error} />;

  const selected = (orders.data ?? []).filter(SCOPES[scope].match);
  const { products, currencies } = summarize(selected);

  const copy = async (): Promise<void> => {
    setCopied(
      await copyText(summaryText(t(SCOPES[scope].label), products, currencies, selected)),
    );
  };

  return (
    <List>
      <PageTitle title={t('adminHome.summary')} />
      <Section>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
          {(Object.keys(SCOPES) as Scope[]).map((key) => (
            <Button
              key={key}
              size="s"
              mode={key === scope ? 'filled' : 'bezeled'}
              onClick={() => {
                setScope(key);
                setCopied(false);
              }}
            >
              {t(SCOPES[key].label)}
            </Button>
          ))}
        </div>
      </Section>

      <Section header={t('summary.totals')}>
        {currencies.length === 0 && <Cell>{t('summary.empty')}</Cell>}
        {currencies.map((c) => (
          <Cell
            key={c.currency}
            subtitle={[
              tn(c.orders, 'count.orders.one', 'count.orders.other'),
              tn(c.items, 'items.one', 'items.other'),
              c.fees > 0 ? t('summary.fees', { amount: formatPrice(c.fees, c.currency) }) : null,
              c.shipping > 0
                ? t('summary.shipping', { amount: formatPrice(c.shipping, c.currency) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            after={<strong>{formatPrice(c.revenue, c.currency)}</strong>}
            multiline
          >
            {c.currency}
          </Cell>
        ))}
      </Section>

      {products.length > 0 && (
        <Section header={t('summary.productsSold')}>
          {products.map((p) => (
            <Cell
              key={p.key}
              subtitle={t('summary.inOrders', { orders: tn(p.orders, 'count.orders.one', 'count.orders.other') })}
              after={formatPrice(p.revenue, p.currency)}
              multiline
            >
              {`${p.quantity}× ${p.title}`}
            </Cell>
          ))}
        </Section>
      )}

      {selected.length > 0 && (
        <Section header={t('summary.orders', { count: selected.length })}>
          {selected.map((order) => (
            <Cell
              key={order.id}
              onClick={() => navigate(to(`/admin/orders/${order.id}`))}
              subtitle={`${statusLabel(order)} · ${formatDate(order.createdAt)}`}
              description={itemsSummary(order)}
              after={formatPrice(order.total, order.currency)}
              multiline
            >
              {`#${order.id.slice(0, 8)}${order.contactUsername ? ` · @${order.contactUsername}` : ''}`}
            </Cell>
          ))}
        </Section>
      )}

      {selected.length > 0 && (
        <Section footer={t('summary.copyFooter')}>
          <div style={{ padding: 16 }}>
            <Button stretched mode="bezeled" onClick={() => void copy()}>
              {copied ? t('key.copied') : t('summary.copy')}
            </Button>
          </div>
        </Section>
      )}
    </List>
  );
}
