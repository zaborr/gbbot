import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input, Textarea } from '../../components/Field.js';
import { ADMIN_STATUS_CHANGES, RATE_SCALE, convertAmount, type Order } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useLiveRefresh } from '../../hooks/useLiveRefresh.js';
import { formatPrice } from '../../lib/format.js';
import { itemKey, itemName } from '../../lib/variants.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import {
  AdminStatusChip,
  AdminOnly,
  ErrorBanner,
  formatDate,
  statusLabel,
  useAdminActions,
  type AdminActions,
} from './common.js';
import { useShopPath } from '../../providers/ShopProvider.js';
import { AddressSection } from './AddressSection.js';
import { TrackingText } from '../../components/TrackingText.js';
import { t, type MessageKey } from '../../i18n/index.js';
import { OrderTracker } from '../../components/OrderStatus.js';

const breakAll: React.CSSProperties = { wordBreak: 'break-all', whiteSpace: 'normal' };

/** Everything about one order, with the admin actions that apply to it. */
export function AdminOrderPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminOrder />
    </AdminOnly>
  );
}

function AdminOrder(): React.JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const to = useShopPath();
  const [reloadKey, setReloadKey] = useState(0);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));
  const order = useAsync(() => api.adminGetOrder(id), [id, reloadKey]);
  const shop = useAsync(() => api.getShop(), []);
  // While the blockchain check runs (e.g. after "Check again"), follow it live.
  useLiveRefresh(
    () => setReloadKey((k) => k + 1),
    order.data?.paymentCheck?.status === 'checking',
  );

  if (order.loading && !order.data) return <Loader />;
  if (order.error) return <ErrorView message={order.error} />;
  if (!order.data) return <Loader />;
  const o = order.data;
  const money = (amount: number): string => formatPrice(amount, o.currency);

  return (
    <List>
      <ErrorBanner message={actions.error} />

      {/* The same tracker the customer sees. */}
      <OrderTracker order={o} />
      <Section
        header={
          <span className="gb-section-head">
            {t('orders.orderNumber', { id: o.id.slice(0, 8) })}
            <AdminStatusChip order={o} />
          </span>
        }
      >
        {o.customerBlocked && <Cell multiline>{t('blacklist.orderNote')}</Cell>}
        <Cell after={statusLabel(o)}>{t('adminOrder.status')}</Cell>
        <Cell after={formatDate(o.createdAt)}>{t('adminOrder.created')}</Cell>
        {o.updatedAt !== o.createdAt && (
          <Cell after={formatDate(o.updatedAt)}>{t('adminOrder.updated')}</Cell>
        )}
        <Cell
          after={
            o.contactUsername ? (
              <a href={`https://t.me/${o.contactUsername}`} target="_blank" rel="noreferrer">
                @{o.contactUsername}
              </a>
            ) : (
              '—'
            )
          }
        >
          {t('adminOrder.customer')}
        </Cell>
        <Cell after={o.userId === null ? '—' : String(o.userId)}>{t('adminOrder.telegramId')}</Cell>
        {o.anonymizedAt && (
          <Cell multiline subtitle={t('adminOrder.since', { date: formatDate(o.anonymizedAt) })}>
            {t('adminOrder.anonymized')}
          </Cell>
        )}
        {o.trackingNumber && (
          <Cell subtitle={t('order.tracking')} multiline>
            <TrackingText value={o.trackingNumber} />
          </Cell>
        )}
        {o.statusNote && (
          <Cell subtitle={t('adminOrder.lastNote')} multiline>
            {o.statusNote}
          </Cell>
        )}
      </Section>

      <Section header={t('adminOrder.items', { count: o.items.reduce((n, i) => n + i.quantity, 0) })}>
        {o.items.map((item) => (
          <Cell
            key={itemKey(item)}
            subtitle={`${item.quantity} × ${money(item.unitPrice)}`}
            after={money(item.subtotal)}
            multiline
          >
            {itemName(item)}
          </Cell>
        ))}
        {o.fee > 0 && (
          <Cell after={money(o.fee)}>{shop.data?.orderFeeLabel ?? t('fee.title')}</Cell>
        )}
        {o.shippingZoneName && (
          <Cell after={o.shipping > 0 ? money(o.shipping) : t('cart.free')}>
            {t('cart.shippingZoneLine', { zone: o.shippingZoneName })}
          </Cell>
        )}
        <Cell after={<strong>{money(o.total)}</strong>}>{t('cart.total')}</Cell>
        {o.isVip && <Cell multiline>{t('adminOrder.vip')}</Cell>}
      </Section>

      <Section header={t('adminOrder.payment')}>
        <Cell after={money(o.amountPaid)}>{t('adminOrder.paid')}</Cell>
        {o.amountSubmitted > 0 && (
          <Cell
            after={money(o.amountSubmitted)}
            subtitle={
              o.paymentExchange
                ? t('adminOrder.paidExchanged', {
                    amount: formatPrice(convertAmount(o.amountSubmitted, o.paymentExchange.rate), o.paymentExchange.token),
                    rate: `1 ${o.currency} = ${o.paymentExchange.rate / RATE_SCALE} ${o.paymentExchange.token}`,
                  })
                : undefined
            }
          >
            {t('adminOrder.toVerify')}
          </Cell>
        )}
        {o.amountDue > 0 && <Cell after={money(o.amountDue)}>{t('adminOrder.due')}</Cell>}
        {o.amountDue < 0 && <Cell after={money(-o.amountDue)}>{t('adminOrder.toRefund')}</Cell>}
        {o.paymentNetwork && <Cell after={o.paymentNetwork}>{t('adminOrder.lastMethod')}</Cell>}
        {o.paymentTxHash && (
          <Cell subtitle={o.paymentManual ? t('adminOrder.reference') : t('adminOrder.lastTx')} multiline>
            {o.paymentTxUrl ? (
              <a href={o.paymentTxUrl} target="_blank" rel="noreferrer" style={breakAll}>
                {o.paymentTxHash}
              </a>
            ) : (
              <span style={breakAll}>{o.paymentTxHash}</span>
            )}
          </Cell>
        )}
        {o.paymentCheck && <PaymentCheckCell order={o} actions={actions} />}
      </Section>

      <AddressSection order={o} />

      {o.changeRequest && <ChangeRequestSection order={o} actions={actions} />}

      {o.paymentLog.length > 0 && (
        <Section header={t('adminOrder.history')}>
          {o.paymentLog.map((entry, index) => (
            <Cell
              key={`${entry.at}-${index}`}
              subtitle={[
                formatDate(entry.at),
                entry.network,
                // Paid in the other token: what arrived and at what rate.
                entry.paid
                  ? t('adminOrder.paidExchanged', {
                      amount: formatPrice(entry.paid.amount, entry.paid.token),
                      rate: `1 ${o.currency} = ${entry.paid.rate / RATE_SCALE} ${entry.paid.token}`,
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              description={
                entry.txHash ? <span style={breakAll}>{entry.txHash}</span> : undefined
              }
              after={`${entry.type === 'refund' ? '−' : '+'}${money(entry.amount)}`}
              multiline
            >
              {entry.type === 'refund' ? t('adminOrder.refundSent') : t('adminOrder.paymentReceived')}
            </Cell>
          ))}
        </Section>
      )}

      <ActionsSection order={o} actions={actions} onDeleted={() => navigate(to('/admin/orders'))} />
    </List>
  );
}

function ChangeRequestSection({
  order,
  actions,
}: {
  order: Order;
  actions: AdminActions;
}): React.JSX.Element | null {
  const change = order.changeRequest;
  if (!change) return null;
  const money = (amount: number): string => formatPrice(amount, order.currency);
  const covered = order.amountPaid + order.amountSubmitted;
  const diff = change.total - covered;

  return (
    <Section
      header={t('adminChange.title')}
      footer={
        diff > 0
          ? t('adminChange.payMore', { amount: money(diff) })
          : diff < 0
            ? t('adminChange.refund', { amount: money(-diff) })
            : t('adminChange.same')
      }
    >
      {change.items.map((item) => {
        const before = order.items.find((i) => itemKey(i) === itemKey(item))?.quantity ?? 0;
        return (
          <Cell
            key={itemKey(item)}
            subtitle={
              before === item.quantity
                ? `${item.quantity} × ${money(item.unitPrice)}`
                : `${before} → ${item.quantity} × ${money(item.unitPrice)}`
            }
            after={money(item.subtotal)}
            multiline
          >
            {before === 0 ? `🆕 ${itemName(item)}` : itemName(item)}
          </Cell>
        );
      })}
      {order.items
        .filter((item) => !change.items.some((c) => itemKey(c) === itemKey(item)))
        .map((item) => (
          <Cell key={itemKey(item)} subtitle={`${item.quantity} → 0`} multiline>
            ❌ {itemName(item)}
          </Cell>
        ))}
      <Cell after={`${money(order.total)} → ${money(change.total)}`}>{t('cart.total')}</Cell>
      <div style={{ display: 'flex', gap: 8, padding: 16 }}>
        <Button
          size="m"
          mode="filled"
          onClick={() =>
            void actions.twoTap(`approve:${order.id}`, () => api.adminApproveChange(order.id))
          }
        >
          {actions.tapLabel(`approve:${order.id}`, t('adminChange.approve'))}
        </Button>
        <Button
          size="m"
          mode="plain"
          onClick={() =>
            void actions.twoTap(`reject:${order.id}`, () => api.adminRejectChange(order.id))
          }
        >
          {actions.tapLabel(`reject:${order.id}`, t('adminChange.reject'))}
        </Button>
      </div>
    </Section>
  );
}

function ActionsSection({
  order,
  actions,
  onDeleted,
}: {
  order: Order;
  actions: AdminActions;
  onDeleted: () => void;
}): React.JSX.Element {
  const money = (amount: number): string => formatPrice(amount, order.currency);
  const { twoTap, tapLabel, run, errorCode } = actions;
  const id = order.id;
  const [note, setNote] = useState('');
  const [tracking, setTracking] = useState(order.trackingNumber ?? '');
  const next = ADMIN_STATUS_CHANGES[order.status];

  /** Changes the status; the bot tells the customer, with the note if there is one. */
  const setStatus = async (
    status: Order['status'],
    more: { trackingNumber?: string; force?: boolean } = {},
  ): Promise<void> => {
    const text = note.trim();
    await api.adminSetOrderStatus(id, status, { ...(text ? { note: text } : {}), ...more });
    setNote('');
  };
  const trackingInput = (): { trackingNumber?: string } =>
    tracking.trim() ? { trackingNumber: tracking.trim() } : {};

  return (
    <Section
      header={t('actions.title')}
      footer={next.length > 0 ? t('actions.footer') : undefined}
    >
      {next.length > 0 && (
        <Textarea
          header={t('actions.note')}
          placeholder={t('actions.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      {next.includes('shipped') && (
        <Input
          header={t('actions.tracking')}
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
        />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
        {order.status === 'awaiting_payment' && (
          <>
            <Button
              stretched
              mode="filled"
              onClick={() => void twoTap(`paid:${id}`, () => setStatus('paid'))}
            >
              {tapLabel(
                `paid:${id}`,
                t('actions.markPaid', { amount: money(order.amountSubmitted || order.amountDue) }),
              )}
            </Button>
            {errorCode === 'stock_short' && (
              <Button
                stretched
                mode="bezeled"
                onClick={() => void run(() => setStatus('paid', { force: true }))}
              >
                {t('actions.confirmAnyway')}
              </Button>
            )}
            <Button
              stretched
              mode="bezeled"
              onClick={() => void twoTap(`reject:${id}`, () => setStatus('pending'))}
            >
              {tapLabel(`reject:${id}`, t('actions.rejectPayment'))}
            </Button>
          </>
        )}
        {order.status === 'paid' && (
          <Button
            stretched
            mode="filled"
            onClick={() => void run(() => setStatus('shipped', trackingInput()))}
          >
            {t('actions.markShipped')}
          </Button>
        )}
        {(order.status === 'paid' || order.status === 'shipped') && (
          <Button
            stretched
            mode="bezeled"
            onClick={() => void twoTap(`delivered:${id}`, () => setStatus('fulfilled'))}
          >
            {tapLabel(`delivered:${id}`, t('actions.markDelivered'))}
          </Button>
        )}
        {order.amountDue < 0 && (
          <Button
            stretched
            mode="bezeled"
            onClick={() => void twoTap(`refund:${id}`, () => api.adminRecordRefund(id))}
          >
            {tapLabel(`refund:${id}`, t('actions.markRefunded', { amount: money(-order.amountDue) }))}
          </Button>
        )}
        {next.includes('cancelled') && (
          <Button
            stretched
            mode="plain"
            onClick={() => void twoTap(`cancel:${id}`, () => setStatus('cancelled'))}
          >
            {tapLabel(
              `cancel:${id}`,
              order.amountPaid > 0
                ? t('actions.cancelRefund', { amount: money(order.amountPaid) })
                : t('actions.cancel'),
            )}
          </Button>
        )}
        <Button
          stretched
          mode="plain"
          onClick={() =>
            void twoTap(`delete:${id}`, async () => {
              await api.adminDeleteOrder(id);
              onDeleted();
            })
          }
        >
          {tapLabel(`delete:${id}`, t('actions.delete'), t('common.tapAgainToDelete'))}
        </Button>
      </div>
    </Section>
  );
}

/** Result of the automatic blockchain check, with a button to run it again. */
function PaymentCheckCell({
  order,
  actions,
}: {
  order: Order;
  actions: AdminActions;
}): React.JSX.Element | null {
  const check = order.paymentCheck;
  if (!check) return null;
  const vars = { network: order.paymentNetwork ?? '—', ...(check.vars ?? {}) };
  const reasonKeys: Record<string, MessageKey> = {
    not_found: 'check.not_found',
    tx_failed: 'check.tx_failed',
    no_transfer: 'check.no_transfer',
    too_old: 'check.too_old',
    short: 'check.short',
    ambiguous: 'check.ambiguous',
    stock_short: 'check.stock_short',
    no_method: 'check.no_method',
  };
  const reason = t(reasonKeys[check.reason ?? ''] ?? 'check.rpc_error', vars);
  const canRecheck = order.status === 'awaiting_payment' && check.status !== 'checking';

  return (
    <Cell
      multiline
      subtitle={t('check.title')}
      description={
        canRecheck ? (
          <Button
            size="s"
            mode="bezeled"
            style={{ marginTop: 8 }}
            onClick={() => void actions.run(() => api.adminRecheckPayment(order.id))}
          >
            {t('check.again')}
          </Button>
        ) : undefined
      }
    >
      {check.status === 'checking'
        ? t('check.checking')
        : check.status === 'verified'
          ? t('check.verified')
          : t('check.failed', { reason })}
    </Cell>
  );
}
