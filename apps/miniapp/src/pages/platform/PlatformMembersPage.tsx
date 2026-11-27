import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { VipClubEditor } from '../../components/VipClubEditor.js';
import { t } from '../../i18n/index.js';

/** Platform super-admin: members by list for private mode (groups and people). */
export function PlatformMembersPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <PlatformMembers />;
}

function PlatformMembers(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.platformGetMembers(), [reloadKey]);
  if (list.loading && !list.data) return <Loader />;
  if (list.error) return <ErrorView message={list.error} />;
  if (!list.data) return <Loader />;
  return (
    <VipClubEditor
      kind="member"
      title={t('members.title')}
      key={list.version}
      club={list.data}
      onSave={async (input) => {
        await api.platformUpdateMembers(input);
        setReloadKey((k) => k + 1);
      }}
    />
  );
}
