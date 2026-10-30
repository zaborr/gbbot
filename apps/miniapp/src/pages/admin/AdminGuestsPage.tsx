import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { VipClubEditor } from '../../components/VipClubEditor.js';
import { t } from '../../i18n/index.js';
import { AdminOnly } from './common.js';

/** The shop's guests: they see it when it is "VIP and guests only". */
export function AdminGuestsPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminGuests />
    </AdminOnly>
  );
}

function AdminGuests(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.adminGetGuests(), [reloadKey]);
  if (list.loading && !list.data) return <Loader />;
  if (list.error) return <ErrorView message={list.error} />;
  if (!list.data) return <Loader />;
  return (
    <VipClubEditor
      kind="guest"
      title={t('adminHome.guests')}
      key={list.version}
      club={list.data}
      useGlobalClub={list.data.useGlobalClub}
      onSave={async (input) => {
        await api.adminUpdateGuests(input);
        setReloadKey((k) => k + 1);
      }}
    />
  );
}
