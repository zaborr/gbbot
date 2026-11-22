import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { BuyerSummary } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { copyText } from '../../lib/clipboard.js';
import { formatPrice } from '../../lib/format.js';
import { toTsv, type CellValue } from '../../lib/orderSheet.js';
import { lineName } from '../../lib/variants.js';
import { Input } from '../../components/Field.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { useShopPath } from '../../providers/ShopProvider.js';
import { AdminOnly } from './common.js';
import { t, tn, type MessageKey } from '../../i18n/index.js';

type Filter = 'all' | 'unpaid' | 'toShip' | 'testing' | 'cart';
const FILTERS: Array<{ key: Filter; label: MessageKey; match: (b: BuyerSummary) => boolean }> = [
  { key: 'all', label: 'catalog.all', match: () => true },
  { key: 'unpaid', label: 'filter.unpaid', match: (b) => b.unpaid },
  { key: 'toShip', label: 'filter.toShip', match: (b) => b.toShip },
  { key: 'testing', label: 'testing.title', match: (b) => b.testing },
  { key: 'cart', label: 'buyers.withCart', match: (b) => b.cartUnits > 0 },
];

/** "Ana · @ana", or "Ana · id 123456789" without a username. */
export const buyerName = (b: Pick<BuyerSummary, 'name' | 'username' | 'telegramId'>): string =>
  b.username ? `${b.name} · @${b.username}` : `${b.name} · id ${b.telegramId}`;

/** The GB's buyers, one per person, with what each has across their orders. */
export function AdminBuyersPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminBuyers />
    </AdminOnly>
  );
}

function AdminBuyers(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const list = useAsync(() => api.adminGetBuyers(), []);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  if (list.loading && !list.data) return <Loader />;
  if (list.error) return <ErrorView message={list.error} />;
  const all = list.data ?? [];
  const query = search.trim().toLowerCase().replace(/^@/, '');
  const match = FILTERS.find((f) => f.key === filter)?.match ?? (() => true);
  const visible = all.filter(
    (b) =>
      match(b) &&
      (!query ||
        b.name.toLowerCase().includes(query) ||
        (b.username ?? '').toLowerCase().includes(query) ||
        String(b.telegramId) === query ||
        b.products.some((p) => lineName(p.title, p.variantLabel).toLowerCase().includes(query))),
  );

  // One row a person, one column a product (units ordered, not cancelled).
  const copy = async (): Promise<void> => {
    const columns = new Map<string, string>();
    for (const b of visible) for (const p of b.products) columns.set(p.key, lineName(p.title, p.variantLabel));
    const keys = [...columns.keys()].sort((a, b) => (columns.get(a) ?? '').localeCompare(columns.get(b) ?? ''));
    const rows: CellValue[][] = [
      [t('buyers.colName'), t('buyers.colUser'), ...keys.map((k) => columns.get(k) ?? ''), t('buyers.colPaid'), t('buyers.colOwed')],
      ...visible.map((b) => {
        const units = new Map(b.products.map((p) => [p.key, p.unpaid + p.paid + p.shipped]));
        return [
          b.name,
          b.username ? `@${b.username}` : '',
          ...keys.map((k) => units.get(k) ?? ''),
          b.paid / 100,
          b.owed / 100,
        ];
      }),
    ];
    setCopied((await copyText(toTsv(rows))) ? t('sheet.copied') : t('sheet.copyFailed'));
  };

  return (
    <List>
      <PageTitle title={t('buyers.title')} />
      <div className="gb-tabs" role="tablist">
        {FILTERS.filter((f) => f.key === 'all' || all.some(f.match)).map((f) => (
          <Button key={f.key} size="s" mode={f.key === filter ? 'filled' : 'bezeled'} onClick={() => setFilter(f.key)}>
            {`${t(f.label)} · ${all.filter(f.match).length}`}
          </Button>
        ))}
      </div>
      <Section>
        <Input
          header={t('adminOrders.search')}
          placeholder={t('buyers.searchPlaceholder')}
          value={search}
          autoCapitalize="none"
          onChange={(e) => setSearch(e.target.value)}
        />
      </Section>
      <Section header={tn(visible.length, 'buyers.count.one', 'buyers.count.other')} footer={t('buyers.footer')}>
        {visible.length === 0 && <Cell multiline>{t('buyers.none')}</Cell>}
        {visible.map((b) => (
          <Cell
            key={b.telegramId}
            onClick={() => navigate(to(`/admin/buyers/${b.telegramId}`))}
            after="›"
            multiline
            subtitle={
              b.products.length > 0
                ? b.products
                    .map((p) => `${p.unpaid + p.paid + p.shipped}× ${lineName(p.title, p.variantLabel)}`)
                    .join(', ')
                : t('buyers.onlyCart')
            }
            description={
              <span className="gb-chips" style={{ marginTop: 6 }}>
                <span className="gb-chip">{tn(b.units, 'buyers.units.one', 'buyers.units.other')}</span>
                {b.owed > 0 && (
                  <span className="gb-chip gb-chip--warn">{t('buyers.owes', { amount: formatPrice(b.owed, b.currency) })}</span>
                )}
                {b.toShip && <span className="gb-chip gb-chip--info">{t('filter.toShip')}</span>}
                {b.cartUnits > 0 && <span className="gb-chip">{tn(b.cartUnits, 'buyers.inCart.one', 'buyers.inCart.other')}</span>}
                {b.testing && <span className="gb-chip">🧪</span>}
                {b.vip && <span className="gb-chip gb-chip--ok">VIP</span>}
                {b.blocked && <span className="gb-chip gb-chip--warn">{t('blacklist.badge')}</span>}
              </span>
            }
          >
            {buyerName(b)}
          </Cell>
        ))}
      </Section>
      {visible.length > 0 && (
        <Section footer={copied ?? t('buyers.copyFooter')}>
          <div style={{ padding: 16 }}>
            <Button stretched mode="bezeled" onClick={() => void copy()}>
              {t('sheet.copy')}
            </Button>
          </div>
        </Section>
      )}
    </List>
  );
}
