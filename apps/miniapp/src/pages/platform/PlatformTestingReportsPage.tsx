import { useState } from 'react';
import { Button, List, Placeholder } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { TestingReports } from '../../components/TestingReports.js';
import { t } from '../../i18n/index.js';

/** Every lab report of every GB (platform admins), with a GB to narrow it to. */
export function PlatformTestingReportsPage(): React.JSX.Element {
  const reports = useAsync(() => api.testingReports('platform'), []);
  const [shopId, setShopId] = useState<string | null>(null);
  if (reports.loading && !reports.data) return <Loader />;
  if (reports.error) return <ErrorView message={reports.error} />;
  const all = reports.data ?? [];
  const shops = [...new Map(all.map((r) => [r.shopId, r.shopName])).entries()];
  const shown = shopId ? all.filter((r) => r.shopId === shopId) : all;
  return (
    <List>
      <PageTitle title={t('reports.title')} />
      {shops.length > 1 && (
        <div className="gb-chips" style={{ padding: '4px 16px 12px' }}>
          <Button size="s" mode={shopId === null ? 'filled' : 'bezeled'} onClick={() => setShopId(null)}>
            {t('reports.allShops')}
          </Button>
          {shops.map(([id, name]) => (
            <Button key={id} size="s" mode={shopId === id ? 'filled' : 'bezeled'} onClick={() => setShopId(id)}>
              {name}
            </Button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <Placeholder header={t('reports.none')} description={t('reports.noneHint')}>
          <span style={{ fontSize: 48 }}>📄</span>
        </Placeholder>
      ) : (
        <TestingReports reports={shown} scope="platform" showShop footer={t('reports.adminFooter')} />
      )}
    </List>
  );
}
