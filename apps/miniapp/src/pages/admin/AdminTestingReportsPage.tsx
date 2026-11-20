import { List, Placeholder } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { TestingReports } from '../../components/TestingReports.js';
import { AdminOnly } from './common.js';
import { t } from '../../i18n/index.js';

/** Every lab report sent in this GB, kept for good (corrections included). */
export function AdminTestingReportsPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <Reports />
    </AdminOnly>
  );
}

function Reports(): React.JSX.Element {
  const reports = useAsync(() => api.testingReports('admin'), []);
  if (reports.loading && !reports.data) return <Loader />;
  if (reports.error) return <ErrorView message={reports.error} />;
  const list = reports.data ?? [];
  return (
    <List>
      <PageTitle title={t('reports.title')} />
      {list.length === 0 ? (
        <Placeholder header={t('reports.none')} description={t('reports.noneHint')}>
          <span style={{ fontSize: 48 }}>📄</span>
        </Placeholder>
      ) : (
        <TestingReports reports={list} scope="admin" footer={t('reports.adminFooter')} />
      )}
    </List>
  );
}
