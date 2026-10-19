import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../../components/Field.js';
import type { ShippingZone } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useShop } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, toMajor, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t } from '../../i18n/index.js';

const PRICE_RE = /^\d+([.,]\d{1,2})?$/;

interface Row {
  key: number;
  id: string | undefined;
  name: string;
  price: string;
  freeFrom: string;
  active: boolean;
}

const toCents = (text: string): number => Math.round(Number(text.replace(',', '.')) * 100);

/** Shipping zones: a flat cost per order, optionally free from an amount. */
export function AdminShippingPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminShipping />
    </AdminOnly>
  );
}

function AdminShipping(): React.JSX.Element {
  const { shop, reload } = useShop();
  return <ShippingForm key={JSON.stringify(shop.shippingZones)} zones={shop.shippingZones} onSaved={reload} />;
}

function ShippingForm({
  zones,
  onSaved,
}: {
  zones: ShippingZone[];
  onSaved: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { shop, to } = useShop();
  const actions = useAdminActions(onSaved);
  const [rows, setRows] = useState<Row[]>(() =>
    zones.map((z, i) => ({
      key: i,
      id: z.id,
      name: z.name,
      price: toMajor(z.price),
      freeFrom: z.freeFrom === null ? '' : toMajor(z.freeFrom),
      active: z.isActive,
    })),
  );
  const [nextKey, setNextKey] = useState(zones.length);
  const [busy, setBusy] = useState(false);

  const update = (key: number, patch: Partial<Row>): void =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const invalid = rows.some(
    (r) =>
      !r.name.trim() ||
      !PRICE_RE.test(r.price.trim()) ||
      (r.freeFrom.trim() !== '' && !PRICE_RE.test(r.freeFrom.trim())),
  );
  const anyActive = rows.some((r) => r.active);

  const save = async (): Promise<void> => {
    setBusy(true);
    await actions.run(() =>
      api.adminUpdateShipping(
        rows.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          name: r.name.trim(),
          price: toCents(r.price.trim()),
          freeFrom: r.freeFrom.trim() === '' ? null : toCents(r.freeFrom.trim()) || null,
          isActive: r.active,
        })),
      ),
    );
    setBusy(false);
  };

  return (
    <List>
      <PageTitle title={t('adminHome.shipping')} />
      <ErrorBanner message={actions.error} />

      {anyActive && !shop.addressPublicKey && (
        <Section>
          <Cell multiline>
            {t('shipping.needKey')}
          </Cell>
          <div style={{ padding: '0 16px 16px' }}>
            <Button size="s" mode="bezeled" onClick={() => navigate(to('/admin/address-key'))}>
              {t('adminHome.addressKey')}
            </Button>
          </div>
        </Section>
      )}

      {rows.length === 0 && (
        <Section>
          <Cell multiline>
            {t('shipping.empty')}
          </Cell>
        </Section>
      )}

      {rows.map((row, index) => (
        <Section key={row.key} header={t('shipping.zone', { n: index + 1 })}>
          <Input
            header={t('shipping.name')}
            placeholder={t('shipping.namePlaceholder')}
            value={row.name}
            onChange={(e) => update(row.key, { name: e.target.value })}
          />
          <Input
            header={t('shipping.cost')}
            type="text"
            inputMode="decimal"
            status={row.price.trim() === '' || PRICE_RE.test(row.price.trim()) ? 'default' : 'error'}
            value={row.price}
            onChange={(e) => update(row.key, { price: e.target.value })}
          />
          <Input
            header={t('shipping.freeFrom')}
            type="text"
            inputMode="decimal"
            placeholder="e.g. 50"
            status={
              row.freeFrom.trim() === '' || PRICE_RE.test(row.freeFrom.trim()) ? 'default' : 'error'
            }
            value={row.freeFrom}
            onChange={(e) => update(row.key, { freeFrom: e.target.value })}
          />
          <Cell
            after={
              <Button
                size="s"
                mode={row.active ? 'bezeled' : 'plain'}
                onClick={() => update(row.key, { active: !row.active })}
              >
                {row.active ? t('variants.on') : t('variants.off')}
              </Button>
            }
          >
            {row.active ? t('shipping.offered') : t('shipping.notOffered')}
          </Cell>
          <div style={{ padding: '0 16px 12px' }}>
            <Button
              size="s"
              mode="plain"
              onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
            >
              {t('shipping.remove')}
            </Button>
          </div>
        </Section>
      ))}

      <Section footer={t('shipping.footer')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            onClick={() => {
              setRows((prev) => [
                ...prev,
                { key: nextKey, id: undefined, name: '', price: '', freeFrom: '', active: true },
              ]);
              setNextKey((k) => k + 1);
            }}
          >
            {t('shipping.add')}
          </Button>
          <Button stretched loading={busy} disabled={invalid} onClick={() => void save()}>
            {t('shipping.save')}
          </Button>
        </div>
      </Section>
    </List>
  );
}
