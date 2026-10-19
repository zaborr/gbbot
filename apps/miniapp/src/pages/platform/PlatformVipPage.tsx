import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { VipClubEditor } from '../../components/VipClubEditor.js';
import { t } from '../../i18n/index.js';

/** Platform super-admin: the VIP club shared by every shop that wants it. */
export function PlatformVipPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <PlatformVip />;
}

function PlatformVip(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const club = useAsync(() => api.platformGetVipClub(), [reloadKey]);
  if (club.loading && !club.data) return <Loader />;
  if (club.error) return <ErrorView message={club.error} />;
  if (!club.data) return <Loader />;
  return (
    <VipClubEditor
      key={club.version}
      club={club.data}
      onSave={async (input) => {
        await api.platformUpdateVipClub(input);
        setReloadKey((k) => k + 1);
      }}
    />
  );
}
