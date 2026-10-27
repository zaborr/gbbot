import { api } from '../../api/client.js';
import { useShop } from '../../providers/ShopProvider.js';
import { BlacklistEditor } from '../../components/BlacklistEditor.js';
import { ErrorView } from '../../components/ErrorView.js';
import { AdminOnly } from './common.js';
import { t } from '../../i18n/index.js';

const shopApi = {
  load: () => api.adminBlacklist(),
  check: (who: string) => api.adminBlacklistCheck(who),
  add: (who: string, removeData: boolean) => api.adminBlacklistAdd(who, removeData),
  remove: (who: string) => api.adminBlacklistRemove(who),
};

/** The GB's administrators: people for whom this GB does not exist. */
export function AdminBlacklistPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <Blacklist />
    </AdminOnly>
  );
}

function Blacklist(): React.JSX.Element {
  const { shop } = useShop();
  if (!shop.canOwn) return <ErrorView message={t('blacklist.ownersOnly')} />;
  return (
    <BlacklistEditor
      title={t('blacklist.title')}
      footer={t('blacklist.footer')}
      platform={false}
      api={shopApi}
    />
  );
}
