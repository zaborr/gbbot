import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import type { PendingRefund } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { formatPrice } from '../../lib/format.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { useShop } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { t } from '../../i18n/index.js';

/** Everything owed back to customers, order by order, with why; each marked once sent. */
export function AdminRefundsPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <Refunds />
    </AdminOnly>
  );
}

function Refunds(): React.JSX.Element {
  const navigate = useNavigate();
  const { to } = useShop();
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.adminPendingRefunds(), [reloadKey]);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));
  if (list.loading && !list.data) return <Loader />;
  if (list.error) return <ErrorView message={list.error} />;
  const refunds = list.data ?? [];
  // Totals per currency, to know how much to send in all.
  const totals = new Map<string, number>();
  for (const r of refunds) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amount);
  return (
    <List>
      <PageTitle title={t('refunds.title')} />
      {refunds.length === 0 ? (
        <Placeholder header={t('refunds.none')} description={t('refunds.noneHint')}>
          <span style={{ fontSize: 48 }}>✅</span>
        </Placeholder>
      ) : (
        <>
          <Section>
            {[...totals.entries()].map(([currency, amount]) => (
              <Cell key={currency} after={<strong>{formatPrice(amount, currency)}</strong>}>
                {t('refunds.total', { count: refunds.filter((r) => r.currency === currency).length })}
              </Cell>
            ))}
          </Section>
          <Section footer={t('refunds.footer')}>
            <ErrorBanner message={actions.error} />
            {refunds.map((r) => (
              <div key={r.orderId}>
                <Cell
                  multiline
                  onClick={() => navigate(to(`/admin/orders/${r.orderId}`))}
                  subtitle={r.reasons.map((reason) => t(`refunds.reason.${reason}`)).join(' · ')}
                  after={<span className="gb-testing-money">{formatPrice(r.amount, r.currency)}</span>}
                >
                  {`#${r.ref} · ${r.customer}`}
                </Cell>
                <RefundButton refund={r} actions={actions} />
              </div>
            ))}
          </Section>
        </>
      )}
    </List>
  );
}

function RefundButton({
  refund,
  actions,
}: {
  refund: PendingRefund;
  actions: ReturnType<typeof useAdminActions>;
}): React.JSX.Element {
  const key = `refund-${refund.orderId}`;
  return (
    <div style={{ padding: '0 16px 12px' }}>
      <Button
        size="s"
        mode="bezeled"
        onClick={() => void actions.twoTap(key, () => api.adminRecordRefund(refund.orderId))}
      >
        {actions.tapLabel(key, t('refunds.markSent'))}
      </Button>
    </div>
  );
}
