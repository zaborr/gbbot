import type { Order, OrderStatus } from '@tma-shop/shared';
import { t, type MessageKey } from '../i18n/index.js';

const STATUS_KEYS: Record<OrderStatus, MessageKey> = {
  pending: 'orderStatus.pending',
  awaiting_payment: 'orderStatus.awaiting_payment',
  paid: 'orderStatus.paid',
  cancelled: 'orderStatus.cancelled',
  shipped: 'orderStatus.shipped',
  fulfilled: 'orderStatus.fulfilled',
};

/** Order status as the customer sees it. */
export function statusText(status: OrderStatus): string {
  return t(STATUS_KEYS[status]);
}

type Kind = 'warn' | 'info' | 'ok' | '';

/** What the order is waiting for, as a coloured label: orange = your turn. */
function chipOf(order: Order): { text: string; kind: Kind } {
  if (order.changeRequest) return { text: t('orders.changeRequested'), kind: 'info' };
  if (order.status === 'pending' && order.amountPaid > 0) {
    return { text: t('orders.differenceToPay'), kind: 'warn' };
  }
  const kinds: Record<OrderStatus, Kind> = {
    pending: 'warn',
    awaiting_payment: 'info',
    paid: 'ok',
    shipped: 'info',
    fulfilled: 'ok',
    cancelled: '',
  };
  return { text: statusText(order.status), kind: kinds[order.status] };
}

export function OrderStatusChip({ order }: { order: Order }): React.JSX.Element {
  const { text, kind } = chipOf(order);
  return <span className={kind ? `gb-chip gb-chip--${kind}` : 'gb-chip'}>{text}</span>;
}

/**
 * Where the order is: ordered → paid → being prepared → shipped → delivered.
 * Not shown for cancelled orders (the label says it).
 */
export function OrderTracker({ order }: { order: Order }): React.JSX.Element | null {
  if (order.status === 'cancelled') return null;
  // Steps already behind it; the next one is where it is now.
  const doneCount: Record<Exclude<OrderStatus, 'cancelled'>, number> = {
    pending: 1,
    awaiting_payment: 1,
    paid: 2,
    shipped: 4,
    fulfilled: 5,
  };
  const done = doneCount[order.status];
  const steps = [
    t('track.ordered'),
    t('track.paid'),
    t('track.preparing'),
    t('track.shipped'),
    t('track.delivered'),
  ];
  return (
    <div className="gb-track" aria-label={statusText(order.status)}>
      {steps.map((label, i) => {
        const state = i < done ? 'done' : i === done ? 'now' : '';
        return (
          <div
            key={label}
            className={state ? `gb-track-step gb-track-step--${state}` : 'gb-track-step'}
          >
            <span
              className={
                state === 'done'
                  ? 'gb-step-dot gb-step-dot--done'
                  : state === 'now'
                    ? 'gb-step-dot gb-step-dot--now'
                    : 'gb-step-dot'
              }
            >
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
