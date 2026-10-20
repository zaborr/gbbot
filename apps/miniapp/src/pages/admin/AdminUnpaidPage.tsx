import { useState } from 'react';
import { List } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { AutoCancelForm } from './AdminSettingsPage.js';
import { AdminOnly } from './common.js';
import { t } from '../../i18n/index.js';

/** How long an unpaid order waits before it is cancelled. */
export function AdminUnpaidPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminUnpaid />
    </AdminOnly>
  );
}

function AdminUnpaid(): React.JSX.Element {
  const { reload } = useShop();
  const [reloadKey, setReloadKey] = useState(0);
  const view = useAsync(() => api.adminGetShop(), [reloadKey]);
  if (view.loading && !view.data) return <Loader />;
  if (view.error) return <ErrorView message={view.error} />;
  if (!view.data) return <Loader />;
  return (
    <List>
      <PageTitle title={t('adminHome.unpaid')} />
      <AutoCancelForm
        key={`auto-cancel-${view.data.autoCancelHours}`}
        view={view.data}
        onSaved={() => {
          setReloadKey((k) => k + 1);
          reload();
        }}
      />
    </List>
  );
}
