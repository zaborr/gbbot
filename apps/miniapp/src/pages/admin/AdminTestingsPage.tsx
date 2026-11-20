import { useNavigate } from 'react-router-dom';
import { formatDateTime } from '../../lib/format.js';
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
import { t, type MessageKey } from '../../i18n/index.js';

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
          <Section footer={t('testing.listFooter')}>
            {(list.data ?? []).length === 0 && <Cell multiline>{t('testing.none')}</Cell>}
            {(list.data ?? []).map((testing) => (
              <Cell
                key={testing.id}
                onClick={() => navigate(to(`/admin/testings/${testing.id}`))}
                subtitle={
                  <span className="gb-chips" style={{ marginTop: 4 }}>
                    <TestingStatusChip testing={testing} />
                    <span className="gb-chip">
                      {t('testing.tiersOf', {
                        reached: testing.tiers.filter((tier) => tier.reached).length,
                        count: testing.tiers.length,
                      })}
                    </span>
                  </span>
                }
                after="›"
                multiline
              >
                {testing.variantLabel
                  ? `${testing.productTitle} · ${testing.variantLabel}`
                  : testing.productTitle}
              </Cell>
            ))}
            <Cell onClick={() => navigate(to('/admin/testings/new'))}>{t('testing.new')}</Cell>
            <Cell onClick={() => navigate(to('/admin/testing-reports'))} after="›">
              {t('reports.title')}
            </Cell>
          </Section>
        ))}
    </List>
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
