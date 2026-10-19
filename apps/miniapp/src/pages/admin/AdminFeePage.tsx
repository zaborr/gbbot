import { useState } from 'react';
import { List } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { OrderFeeForm } from './OrderFeeForm.js';
import { useShop } from '../../providers/ShopProvider.js';
import { PageTitle } from '../../components/PageTitle.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { t } from '../../i18n/index.js';

/** Fixed fee added once to every new order (0 = none, hidden from customers). */
export function AdminFeePage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminFee />
    </AdminOnly>
  );
}

function AdminFee(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const { reload } = useShop();
  const actions = useAdminActions(() => {
    setReloadKey((k) => k + 1);
    reload();
  });
  const shop = useAsync(() => api.getShop(), [reloadKey]);

  if (shop.loading && !shop.data) return <Loader />;
  if (shop.error) return <ErrorView message={shop.error} />;
  if (!shop.data) return <Loader />;

  return (
    <List>
      <PageTitle title={t('adminHome.fee')} />
      <ErrorBanner message={actions.error} />
      <OrderFeeForm
        key={`${shop.data.orderFee}-${shop.data.orderFeeLabel}-${shop.data.vipNoFee}`}
        fee={shop.data.orderFee}
        label={shop.data.orderFeeLabel}
        vipNoFee={shop.data.vipNoFee}
        onSave={(fee, label, vipNoFee) =>
          actions.run(() => api.adminUpdateOrderFee(fee, label, vipNoFee))
        }
      />
    </List>
  );
}
