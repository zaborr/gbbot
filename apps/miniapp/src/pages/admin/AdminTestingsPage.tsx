import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Cell, List, Section, Switch } from '@telegram-apps/telegram-ui';
import { testingTotalCost, type Testing } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { formatPrice } from '../../lib/format.js';
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

export function TestingStatusChip({ status }: { status: Testing['status'] }): React.JSX.Element {
  const { key, chip } = STATUS[status];
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
                    <TestingStatusChip status={testing.status} />
                    <span className="gb-chip">
                      {formatPrice(testing.raised, testing.currency)} /{' '}
                      {formatPrice(testingTotalCost(testing.tiers), testing.currency)}
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
