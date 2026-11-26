import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Section, Switch } from '@telegram-apps/telegram-ui';
import type { Product } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { Input } from '../../components/Field.js';
import { formatPrice } from '../../lib/format.js';
import { activeVariants, hasVariants, lineName } from '../../lib/variants.js';
import { productTitle } from '../../lib/localize.js';
import { useShopPath } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { t } from '../../i18n/index.js';

interface Line {
  key: string;
  product: Product;
  variantId: string | null;
  label: string;
  quantity: string;
  /** A price typed by hand (major units), empty: the usual. */
  price: string;
}

const MONEY_RE = /^\d+([.,]\d{1,2})?$/;
const cents = (text: string): number => Math.round(Number(text.trim().replace(',', '.')) * 100);

/** The organisers make an order for someone: products, zone, paid or not. */
export function AdminCreateOrderPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <CreateOrder />
    </AdminOnly>
  );
}

function CreateOrder(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const [reloadKey, setReloadKey] = useState(0);
  const products = useAsync(() => api.adminGetProducts(), []);
  const shop = useAsync(() => api.getShop(), []);
  const pending = useAsync(() => api.adminPendingOrders(), [reloadKey]);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));
  const [who, setWho] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [notify, setNotify] = useState(true);
  const [done, setDone] = useState<string | null>(null);

  if ((products.loading && !products.data) || (shop.loading && !shop.data)) return <Loader />;
  if (products.error) return <ErrorView message={products.error} />;
  const all = products.data ?? [];
  const zones = (shop.data?.shippingZones ?? []).filter((z) => z.isActive);
  const currency = lines[0]?.product.currency ?? all[0]?.currency ?? 'EUR';
  const query = search.trim().toLowerCase();
  const found = query === '' ? [] : all.filter((p) => productTitle(p).toLowerCase().includes(query)).slice(0, 8);

  const add = (product: Product, variantId: string | null, label: string): void => {
    setLines((prev) => [
      ...prev,
      { key: `${product.id}-${variantId ?? ''}-${prev.length}`, product, variantId, label, quantity: '1', price: '' },
    ]);
    setSearch('');
  };
  const update = (key: string, change: Partial<Line>): void =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...change } : l)));
  const unitOf = (l: Line): number =>
    l.price.trim() !== '' && MONEY_RE.test(l.price.trim())
      ? cents(l.price)
      : (activeVariants(l.product).find((v) => v.id === l.variantId)?.price ?? l.product.price);
  const bad =
    who.trim() === '' ||
    lines.length === 0 ||
    lines.some((l) => !/^\d+$/.test(l.quantity) || Number(l.quantity) < 1 || (l.price.trim() !== '' && !MONEY_RE.test(l.price.trim()))) ||
    (zones.length > 0 && !zones.some((z) => z.id === zoneId));
  const estimate = lines.reduce((sum, l) => sum + unitOf(l) * (Number(l.quantity) || 0), 0);

  const create = (): Promise<void> =>
    actions.run(async () => {
      const result = await api.adminCreateOrder({
        who: who.trim(),
        items: lines.map((l) => ({
          productId: l.product.id,
          variantId: l.variantId,
          quantity: Number(l.quantity),
          unitPrice: l.price.trim() !== '' ? cents(l.price) : null,
        })),
        shippingZoneId: zoneId,
        paid,
        notify,
      });
      if (result.order) {
        navigate(to(`/admin/orders/${result.order.id}`));
        return;
      }
      setDone(t('adminCreate.pendingDone'));
      setWho('');
      setLines([]);
    });

  return (
    <List>
      <ErrorBanner message={actions.error} />
      <Section header={t('adminCreate.title')} footer={t('adminCreate.whoFooter')}>
        <Input
          header={t('adminCreate.who')}
          placeholder="@usuario"
          autoCapitalize="none"
          value={who}
          onChange={(e) => setWho(e.target.value)}
        />
      </Section>

      <Section header={t('adminCreate.products')}>
        {lines.map((l) => (
          <div key={l.key} style={{ padding: '8px 16px' }}>
            <Cell
              multiline
              after={
                <Button size="s" mode="plain" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>
                  ✕
                </Button>
              }
              subtitle={formatPrice(unitOf(l) * (Number(l.quantity) || 0), l.product.currency)}
            >
              {lineName(productTitle(l.product), l.label || null)}
            </Cell>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <Input
                  header={t('adminCreate.quantity')}
                  type="text"
                  inputMode="numeric"
                  value={l.quantity}
                  onChange={(e) => update(l.key, { quantity: e.target.value })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Input
                  header={t('adminCreate.price', { currency: l.product.currency })}
                  type="text"
                  inputMode="decimal"
                  placeholder={(unitOf({ ...l, price: '' }) / 100).toFixed(2)}
                  value={l.price}
                  onChange={(e) => update(l.key, { price: e.target.value })}
                />
              </div>
            </div>
          </div>
        ))}
        <Input
          header={t('adminCreate.add')}
          placeholder={t('adminCreate.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {found.map((p) =>
          hasVariants(p) ? (
            activeVariants(p).map((v) => (
              <Cell key={`${p.id}-${v.id}`} onClick={() => add(p, v.id, v.label)} after={formatPrice(v.price, p.currency)}>
                {lineName(productTitle(p), v.label)}
              </Cell>
            ))
          ) : (
            <Cell key={p.id} onClick={() => add(p, null, '')} after={formatPrice(p.price, p.currency)}>
              {productTitle(p)}
            </Cell>
          ),
        )}
        {lines.length > 0 && (
          <Cell after={formatPrice(estimate, currency)} multiline subtitle={t('adminCreate.estimateNote')}>
            {t('adminCreate.subtotal')}
          </Cell>
        )}
      </Section>

      {zones.length > 0 && (
        <Section header={t('adminCreate.zone')} footer={t('adminCreate.zoneFooter')}>
          <div className="gb-tabs" role="tablist" style={{ padding: '8px 16px' }}>
            {zones.map((z) => (
              <Button key={z.id} size="s" mode={zoneId === z.id ? 'filled' : 'bezeled'} onClick={() => setZoneId(z.id)}>
                {z.name}
              </Button>
            ))}
          </div>
        </Section>
      )}

      <Section footer={done ?? t('adminCreate.footer')}>
        <Cell Component="label" multiline after={<Switch checked={paid} onChange={(e) => setPaid(e.target.checked)} />}>
          {t('adminCreate.paid')}
        </Cell>
        <Cell Component="label" multiline after={<Switch checked={notify} onChange={(e) => setNotify(e.target.checked)} />}>
          {t('adminCreate.notify')}
        </Cell>
        <div style={{ padding: 16 }}>
          <Button stretched disabled={bad} onClick={() => void create()}>
            {t('adminCreate.submit')}
          </Button>
        </div>
      </Section>

      {(pending.data ?? []).length > 0 && (
        <Section header={t('adminCreate.pendingTitle')} footer={t('adminCreate.pendingFooter')}>
          {(pending.data ?? []).map((p) => (
            <Cell
              key={p.id}
              subtitle={t('adminCreate.pendingItems', { count: p.request.items.reduce((n, i) => n + i.quantity, 0) })}
              after={
                <Button
                  size="s"
                  mode="plain"
                  onClick={() => void actions.twoTap(`pending-${p.id}`, () => api.adminRemovePendingOrder(p.id))}
                >
                  {actions.tapLabel(`pending-${p.id}`, t('testing.invites.remove'))}
                </Button>
              }
            >
              {`⏳ ${/^\d+$/.test(p.who) ? p.who : `@${p.who}`}`}
            </Cell>
          ))}
        </Section>
      )}
    </List>
  );
}
