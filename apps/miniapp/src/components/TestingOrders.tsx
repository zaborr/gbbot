import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import type { Testing, TestingParticipant } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { copyText } from '../lib/clipboard.js';
import { formatPrice } from '../lib/format.js';
import { toTsv } from '../lib/orderSheet.js';
import { useShop } from '../providers/ShopProvider.js';
import { ErrorBanner, useAdminActions } from '../pages/admin/common.js';
import { Input } from './Field.js';
import { Loader } from './Loader.js';
import { t, tn, type MessageKey } from '../i18n/index.js';

type Filter = 'all' | 'unpaid' | 'volunteers' | 'donors' | 'external';
const FILTERS: Array<{ key: Filter; label: MessageKey; match: (p: TestingParticipant) => boolean }> = [
  { key: 'all', label: 'catalog.all', match: () => true },
  { key: 'unpaid', label: 'filter.unpaid', match: (p) => !p.paid },
  { key: 'volunteers', label: 'testing.orders.volunteers', match: (p) => p.volunteer },
  { key: 'donors', label: 'testing.orders.donors', match: (p) => p.donor },
  { key: 'external', label: 'testing.orders.external', match: (p) => p.external },
];

const units = (n: number): string => tn(n, 'testing.units.one', 'testing.units.other');

/**
 * The orders in a testing: who takes part, filtered and searched, copied as
 * a table, and a reminder through the bot to those who have not paid.
 */
export function TestingOrders({ testing }: { testing: Testing }): React.JSX.Element {
  const navigate = useNavigate();
  const { to } = useShop();
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.adminGetTestingParticipants(testing.id), [testing.id, reloadKey]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [reminded, setReminded] = useState<number | null>(null);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));

  if (!list.data) return list.error ? <ErrorBanner message={list.error} /> : <Loader />;
  const all = list.data;
  const fmt = (amount: number): string => formatPrice(amount, testing.currency);
  const perUnit = testing.money?.perUnit ?? 0;
  const query = search.trim().toLowerCase().replace(/^[@#]/, '');
  const match = FILTERS.find((f) => f.key === filter)?.match ?? (() => true);
  const visible = all.filter(
    (p) =>
      match(p) &&
      (!query ||
        p.name.toLowerCase().includes(query) ||
        (p.contact ?? '').toLowerCase().includes(query) ||
        p.ref.toLowerCase().includes(query)),
  );
  // Only the filters with someone in them (and "all").
  const filters = FILTERS.filter((f) => f.key === 'all' || all.some(f.match));
  const unpaid = all.filter((p) => !p.paid).length;

  const copy = async (): Promise<void> => {
    const rows = [
      [
        t('testing.orders.colOrder'),
        t('testing.orders.colName'),
        t('testing.orders.colContact'),
        t('testing.orders.colUnits'),
        t('testing.orders.colAmount'),
        t('testing.orders.colExtra'),
        t('testing.orders.colPaid'),
        t('testing.orders.volunteers'),
        t('testing.orders.donors'),
        t('testing.orders.external'),
      ],
      ...visible.map((p) => [
        p.ref,
        p.name,
        p.contact ? `@${p.contact}` : '',
        p.units,
        p.exempt ? 0 : p.amount / 100,
        p.extra / 100,
        p.paid ? '✓' : '',
        p.volunteer ? '✓' : '',
        p.donor ? '✓' : '',
        p.external ? '✓' : '',
      ]),
    ];
    setCopied((await copyText(toTsv(rows))) ? t('sheet.copied') : t('sheet.copyFailed'));
  };

  return (
    <>
      <ErrorBanner message={actions.error} />
      <div className="gb-tabs" role="tablist">
        {filters.map((f) => (
          <Button
            key={f.key}
            size="s"
            mode={f.key === filter ? 'filled' : 'bezeled'}
            onClick={() => setFilter(f.key)}
          >
            {`${t(f.label)} · ${all.filter(f.match).length}`}
          </Button>
        ))}
      </div>
      {all.length > 0 && (
        <Section>
          <Input
            header={t('adminOrders.search')}
            placeholder={t('testing.orders.searchPlaceholder')}
            value={search}
            autoCapitalize="none"
            onChange={(e) => setSearch(e.target.value)}
          />
        </Section>
      )}
      <Section
        header={t('testing.participants', { count: visible.length })}
        footer={t('testing.participantsMoneyFooter', {
          payers: testing.participants,
          volunteers: all.filter((p) => p.volunteer).length,
        })}
      >
        {visible.length === 0 && <Cell multiline>{t('testing.noParticipants')}</Cell>}
        {visible.map((p) => (
          <Cell
            key={p.orderId}
            onClick={() => navigate(to(`/admin/orders/${p.orderId}`))}
            subtitle={[
              `#${p.ref}`,
              p.external ? t('testing.orders.externalChip') : units(p.units),
              p.extra > 0 ? t('testing.participantExtra', { amount: fmt(p.extra) }) : null,
              perUnit > 0 && !p.external ? t('testing.participantHidden', { amount: fmt(perUnit * p.units) }) : null,
              p.paid ? t('testing.paid') : t('testing.unpaid'),
              p.volunteer ? t('testing.volunteerChip') : null,
              p.donor ? t('testing.orders.donorChip') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            after={p.exempt ? t('testing.exemptChip') : fmt(p.amount)}
            multiline
          >
            {p.contact ? `${p.name} · @${p.contact}` : p.name}
          </Cell>
        ))}
      </Section>
      {unpaid > 0 && (
        <Section footer={reminded !== null ? tn(reminded, 'testing.orders.reminded.one', 'testing.orders.reminded.other') : t('testing.orders.remindFooter')}>
          <div style={{ padding: 16 }}>
            <Button
              stretched
              mode="bezeled"
              onClick={() =>
                void actions.twoTap('remind', async () => {
                  setReminded((await api.adminRemindTestingUnpaid(testing.id)).sent);
                })
              }
            >
              {actions.tapLabel('remind', tn(unpaid, 'testing.orders.remind.one', 'testing.orders.remind.other'))}
            </Button>
          </div>
        </Section>
      )}
      {visible.length > 0 && (
        <Section footer={copied ?? t('testing.orders.copyFooter')}>
          <div style={{ padding: 16 }}>
            <Button stretched mode="bezeled" onClick={() => void copy()}>
              {t('sheet.copy')}
            </Button>
          </div>
        </Section>
      )}
    </>
  );
}
