import { Cell } from '@telegram-apps/telegram-ui';
import { t } from '../i18n/index.js';

const breakAll: React.CSSProperties = { wordBreak: 'break-all', whiteSpace: 'normal' };

/** A shipment tracking number, or a link when it is one. */
export function TrackingText({ value }: { value: string }): React.JSX.Element {
  return /^https?:\/\//i.test(value) ? (
    <a href={value} target="_blank" rel="noreferrer" style={breakAll}>
      {value}
    </a>
  ) : (
    <span style={breakAll}>{value}</span>
  );
}

/** Carrier and tracking of a shipped order (nothing when neither is set). */
export function ShipmentCells({
  order,
}: {
  order: { carrier: string | null; trackingNumber: string | null };
}): React.JSX.Element | null {
  if (!order.carrier && !order.trackingNumber) return null;
  return (
    <Cell subtitle={order.carrier ? t('order.carrierTracking', { carrier: order.carrier }) : t('order.tracking')} multiline>
      {order.trackingNumber ? <TrackingText value={order.trackingNumber} /> : '—'}
    </Cell>
  );
}
