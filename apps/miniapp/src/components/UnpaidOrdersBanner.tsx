import { useNavigate } from 'react-router-dom';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import { payBefore, type Order } from '@tma-shop/shared';
import { formatPrice } from '../lib/format.js';
import { useShop, useShopPath } from '../providers/ShopProvider.js';
import { locale, t } from '../i18n/index.js';

/**
 * A quiet, fixed note at the top of the catalog while the customer has orders
 * still to pay, with a button straight to the payment. Goes away by itself
 * once they are paid or cancelled.
 */
export function UnpaidOrdersBanner({ orders }: { orders: Order[] }): React.JSX.Element | null {
  const navigate = useNavigate();
  const to = useShopPath();
  const { shop } = useShop();
  const first = orders[0];
  if (!first) return null;

  const single = orders.length === 1;
  const deadline = single ? payBefore(first, shop.autoCancelHours) : null;
  const subtitle = single
    ? [
        formatPrice(first.amountDue, first.currency),
        deadline
          ? t('unpaid.before', {
              date: deadline.toLocaleString(locale(), {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }),
            })
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : t('unpaid.manyHint');

  return (
    <Section>
      <Cell
        className="tma-notice"
        before={<span style={{ fontSize: 22 }}>🧾</span>}
        subtitle={subtitle}
        after={
          <Button
            size="s"
            onClick={() => navigate(to(single ? `/orders/${first.id}` : '/orders'))}
          >
            {single ? t('unpaid.pay') : t('unpaid.see')}
          </Button>
        }
        multiline
      >
        {single ? t('unpaid.one') : t('unpaid.many', { count: orders.length })}
      </Cell>
    </Section>
  );
}
