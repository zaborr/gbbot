import { useNavigate } from 'react-router-dom';
import { formatDateTime, formatPrice } from '../../lib/format.js';
import { useState } from 'react';
import { Cell, List, Section, Switch } from '@telegram-apps/telegram-ui';
import type { Testing } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { t, tn, type MessageKey } from '../../i18n/index.js';
import { TestingBar } from '../../components/TestingCard.js';
import { potLine, TestingNextLine } from '../../components/TestingNext.js';

const STATUS: Record<Testing['status'], { key: MessageKey; chip: string }> = {
  open: { key: 'testing.status.open', chip: 'gb-chip--info' },
  closed: { key: 'testing.status.closed', chip: 'gb-chip--soft' },
  drawing: { key: 'testing.status.drawing', chip: 'gb-chip--soft' },
  drawn: { key: 'testing.status.drawn', chip: 'gb-chip--soft' },
  settled: { key: 'testing.status.settled', chip: 'gb-chip--ok' },
  cancelled: { key: 'testing.status.cancelled', chip: '' },
};

export function TestingStatusChip({
  testing,
}: {
  testing: Pick<Testing, 'status' | 'donationsOpen' | 'donationsUntil'>;
}): React.JSX.Element {
  // The GB is closed, but people can still join and give until then.
  if (testing.status === 'closed' && testing.donationsOpen && testing.donationsUntil) {
    return (
      <span className="gb-chip gb-chip--info">
        {t('testing.status.windowOpen', { date: formatDateTime(testing.donationsUntil) })}
      </span>
    );
  }
  const { key, chip } = STATUS[testing.status];
  return <span className={`gb-chip ${chip}`}>{t(key)}</span>;
}

/** The GB's product testings, and a way to start a new one. */
export function AdminTestingsPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminTestings />
    </AdminOnly>
  );
}

function AdminTestings(): React.JSX.Element {
  const navigate = useNavigate();
  const { shop, to } = useShop();
  const list = useAsync(() => api.adminGetTestings(), [shop.testingEnabled]);
  const all = list.data ?? [];
  // Those that need the organisers first, then the ones going on, then the finished.
  const finished = (x: Testing): boolean => x.status === 'settled' || x.status === 'cancelled';
  const groups: Array<{ key: string; header: MessageKey; items: Testing[] }> = [
    { key: 'action', header: 'testing.panel.action', items: all.filter((x) => !finished(x) && x.next?.action) },
    { key: 'going', header: 'testing.panel.going', items: all.filter((x) => !finished(x) && !x.next?.action) },
    { key: 'done', header: 'testing.panel.done', items: all.filter(finished).reverse() },
  ];

  return (
    <List>
      <PageTitle title={t('testing.title')} />
      <TestingSwitch />
      {shop.testingEnabled &&
        (list.loading && !list.data ? (
          <Loader />
        ) : list.error ? (
          <ErrorView message={list.error} />
        ) : (
          <>
            {all.length === 0 && (
              <Section>
                <Cell multiline>{t('testing.none')}</Cell>
              </Section>
            )}
            {groups
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <Section key={group.key} header={t(group.header)}>
                  {group.items.map((testing) => (
                    <TestingPanelCell
                      key={testing.id}
                      testing={testing}
                      onOpen={() => navigate(to(`/admin/testings/${testing.id}`))}
                    />
                  ))}
                </Section>
              ))}
            {totalsLine(all) && (
              <Section>
                <Cell multiline>{totalsLine(all)}</Cell>
              </Section>
            )}
            <Section footer={t('testing.listFooter')}>
              <Cell onClick={() => navigate(to('/admin/testings/new'))}>{t('testing.new')}</Cell>
              <Cell onClick={() => navigate(to('/admin/testing-reports'))} after="›">
                {t('reports.title')}
              </Cell>
              <Cell onClick={() => navigate(to('/admin/labs'))} after="›">
                {t('labs.title')}
              </Cell>
            </Section>
          </>
        ))}
    </List>
  );
}

/** What each person pays: the extra round's share while it lasts, else the fee. */
function perPerson(testing: Testing): string {
  const fmt = (amount: number): string => formatPrice(amount, testing.currency);
  const share = testing.extra?.estimate.share ?? null;
  if (testing.extra && testing.extra.outcome === null && share !== null) {
    return t('testing.panel.extraPerPerson', { amount: fmt(share) });
  }
  return testing.contribution > 0
    ? t('testing.panel.perPerson', { amount: fmt(testing.contribution) })
    : t('testing.panel.noFee');
}

/** The testings going on, added up: how many, people on them and the pot (per currency). */
function totalsLine(items: Testing[]): string | null {
  const live = items.filter((x) => x.status !== 'settled' && x.status !== 'cancelled' && x.money);
  if (live.length === 0) return null;
  const pots = new Map<string, number>();
  for (const x of live) pots.set(x.currency, (pots.get(x.currency) ?? 0) + (x.money?.pot ?? 0));
  return t('testing.panel.totals', {
    testings: live.length,
    people: live.reduce((sum, x) => sum + (x.money?.entries ?? 0), 0),
    pot: [...pots].map(([currency, amount]) => formatPrice(amount, currency)).join(' + '),
  });
}

/** One testing in the panel: what comes next, how far the pot is, who paid. */
function TestingPanelCell({ testing, onOpen }: { testing: Testing; onOpen: () => void }): React.JSX.Element {
  const live = testing.status !== 'settled' && testing.status !== 'cancelled';
  const unpaid = testing.next?.unpaid ?? 0;
  const pot = live ? potLine(testing) : null;
  return (
    <Cell
      onClick={onOpen}
      after="›"
      multiline
      subtitle={testing.next && live ? <TestingNextLine next={testing.next} /> : undefined}
      description={
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {live && <TestingBar testing={testing} />}
          {pot && <span>{pot}</span>}
          <span className="gb-chips">
            <TestingStatusChip testing={testing} />
            <span className="gb-chip">
              {t('testing.tiersOf', {
                reached: testing.tiers.filter((tier) => tier.reached).length,
                count: testing.tiers.length,
              })}
            </span>
            {live && testing.money && (
              <span className="gb-chip">
                {tn(testing.money.entries, 'testing.panel.entries.one', 'testing.panel.entries.other')}
              </span>
            )}
            {live && <span className="gb-chip">{tn(testing.participants, 'testing.panel.paid.one', 'testing.panel.paid.other')}</span>}
            {live && <span className="gb-chip">{perPerson(testing)}</span>}
            {live && unpaid > 0 && (
              <span className="gb-chip gb-chip--warn">{tn(unpaid, 'testing.panel.unpaid.one', 'testing.panel.unpaid.other')}</span>
            )}
          </span>
        </span>
      }
    >
      {testing.variantLabel ? `${testing.productTitle} · ${testing.variantLabel}` : testing.productTitle}
    </Cell>
  );
}

/** Product testing on or off for the GB (administrators). */
function TestingSwitch(): React.JSX.Element {
  const { shop, reload } = useShop();
  const actions = useAdminActions(reload);
  const [busy, setBusy] = useState(false);
  return (
    <Section
      footer={
        shop.canOwn
          ? t('testing.switchFooter')
          : `${t('testing.switchFooter')} ${t('testing.switchFooterOwners')}`
      }
    >
      <ErrorBanner message={actions.error} />
      <Cell
        Component="label"
        after={
          <Switch
            checked={shop.testingEnabled}
            disabled={!shop.canOwn || busy}
            onChange={(e) => {
              const enabled = e.target.checked;
              setBusy(true);
              void actions.run(() => api.adminSetTestingEnabled(enabled)).finally(() => setBusy(false));
            }}
          />
        }
        multiline
      >
        {t('testing.switch')}
      </Cell>
    </Section>
  );
}
