import { useNavigate } from 'react-router-dom';
import { Cell, List, Section } from '@telegram-apps/telegram-ui';
import { testingTotalCost, type Testing } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { formatPrice } from '../../lib/format.js';
import { AdminOnly } from './common.js';
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
  const list = useAsync(() => api.adminGetTestings(), []);

  if (!shop.testingEnabled) {
    return (
      <List>
        <PageTitle title={t('testing.title')} />
        <Section footer={t('testing.offFooter')}>
          <Cell onClick={() => navigate(to('/admin/settings'))} after="›" multiline>
            {t('testing.turnOn')}
          </Cell>
        </Section>
      </List>
    );
  }
  if (list.loading && !list.data) return <Loader />;
  if (list.error) return <ErrorView message={list.error} />;
  const testings = list.data ?? [];

  return (
    <List>
      <PageTitle title={t('testing.title')} />
      <Section footer={t('testing.listFooter')}>
        {testings.length === 0 && <Cell multiline>{t('testing.none')}</Cell>}
        {testings.map((testing) => (
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
    </List>
  );
}
