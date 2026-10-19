import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { VipClubEditor } from '../../components/VipClubEditor.js';
import { t } from '../../i18n/index.js';
import { AdminOnly } from './common.js';

/** The shop's own VIP club. */
export function AdminVipPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminVip />
    </AdminOnly>
  );
}

function AdminVip(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const club = useAsync(() => api.adminGetVipClub(), [reloadKey]);
  if (club.loading && !club.data) return <Loader />;
  if (club.error) return <ErrorView message={club.error} />;
  if (!club.data) return <Loader />;
  return (
    <VipClubEditor
      title={t('adminHome.vip')}
      key={club.version}
      club={club.data}
      useGlobalClub={club.data.useGlobalClub}
      onSave={async (input) => {
        await api.adminUpdateVipClub(input);
        setReloadKey((k) => k + 1);
      }}
    />
  );
}
