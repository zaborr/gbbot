import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { VipClubEditor } from '../../components/VipClubEditor.js';
import { t } from '../../i18n/index.js';

/** Platform super-admin: the guests shared by every GB that wants them. */
export function PlatformGuestsPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <PlatformGuests />;
}

function PlatformGuests(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.platformGetGuests(), [reloadKey]);
  if (list.loading && !list.data) return <Loader />;
  if (list.error) return <ErrorView message={list.error} />;
  if (!list.data) return <Loader />;
  return (
    <VipClubEditor
      kind="guest"
      title={t('platform.guests')}
      key={list.version}
      club={list.data}
      onSave={async (input) => {
        await api.platformUpdateGuests(input);
        setReloadKey((k) => k + 1);
      }}
    />
  );
}
