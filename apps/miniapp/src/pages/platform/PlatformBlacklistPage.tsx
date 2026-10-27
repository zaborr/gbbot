import { api } from '../../api/client.js';
import { useSession } from '../../providers/SessionProvider.js';
import { BlacklistEditor } from '../../components/BlacklistEditor.js';
import { ErrorView } from '../../components/ErrorView.js';
import { t } from '../../i18n/index.js';

const platformApi = {
  load: () => api.platformBlacklist(),
  check: (who: string) => api.platformBlacklistCheck(who),
  add: (who: string, removeData: boolean) => api.platformBlacklistAdd(who, removeData),
  remove: (who: string) => api.platformBlacklistRemove(who),
};

/** Platform admins: people for whom no GB exists. */
export function PlatformBlacklistPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return (
    <BlacklistEditor
      title={t('blacklist.platformTitle')}
      footer={t('blacklist.platformFooter')}
      platform
      api={platformApi}
    />
  );
}
