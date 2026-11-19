import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input, Textarea } from '../../components/Field.js';
import { ADMIN_STATUS_CHANGES, RATE_SCALE, convertAmount, type Order, type ReducePreview } from '@tma-shop/shared';
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
import { CopyOrders } from '../../components/CopyOrders.js';
import { ShipmentCells } from '../../components/TrackingText.js';
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
        {o.external && <Cell multiline>{t('adminOrder.externalNote')}</Cell>}
        {o.extraUnpaid?.map((product) => (
          <Cell key={product} multiline>
            ⚠️ {t('blacklist.extraUnpaid', { product })}
          </Cell>
        ))}
        {o.extraUnpaid && !o.customerBlocked && o.userId !== null && shop.data?.canOwn && (
          <div style={{ padding: '4px 16px 12px' }}>
            <Button
              size="s"
              mode="bezeled"
              onClick={() =>
                navigate(
                  `${to('/admin/blacklist')}?${new URLSearchParams({
                    who: String(o.userId),
                    reason: (o.extraUnpaid ?? []).map((product) => t('blacklist.extraUnpaid', { product })).join(' '),
                  }).toString()}`,
                )
              }
            >
              {t('blacklist.blockFromOrder')}
            </Button>
          </div>
        )}
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
        <ShipmentCells order={o} />
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
        {o.testing > 0 && <Cell after={money(o.testing)}>{t('testing.orderLine')}</Cell>}
        {o.donatedVials.map((v) => (
          <Cell key={v} multiline>
            {t('testing.minusVialAdmin', { item: v })}
          </Cell>
        ))}
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

      <CopyOrders orders={[o]} several={false} />

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
  const [shipping, setShipping] = useState(false);
  const next = ADMIN_STATUS_CHANGES[order.status];
  const [reducing, setReducing] = useState(false);

  /** Changes the status; the bot tells the customer, with the note if there is one. */
  const setStatus = async (
    status: Order['status'],
    more: { trackingNumber?: string; carrier?: string; force?: boolean } = {},
  ): Promise<void> => {
    const text = note.trim();
    await api.adminSetOrderStatus(id, status, { ...(text ? { note: text } : {}), ...more });
    setNote('');
  };

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
        {order.status === 'paid' &&
          (shipping ? (
            <ShipForm
              order={order}
              confirmLabel={t('actions.confirmShipped')}
              onCancel={() => setShipping(false)}
              onSave={(shipment) =>
                run(async () => {
                  await setStatus('shipped', {
                    ...(shipment.carrier ? { carrier: shipment.carrier } : {}),
                    ...(shipment.trackingNumber ? { trackingNumber: shipment.trackingNumber } : {}),
                  });
                  setShipping(false);
                })
              }
            />
          ) : (
            <Button stretched mode="filled" onClick={() => setShipping(true)}>
              {t('actions.markShipped')}
            </Button>
          ))}
        {(order.status === 'shipped' || order.status === 'fulfilled') &&
          (shipping ? (
            <ShipForm
              order={order}
              confirmLabel={t('actions.saveShipment')}
              onCancel={() => setShipping(false)}
              onSave={(shipment) =>
                run(async () => {
                  await api.adminUpdateShipment(id, shipment);
                  setShipping(false);
                })
              }
            />
          ) : (
            <Button stretched mode="bezeled" onClick={() => setShipping(true)}>
              {t('actions.editShipment')}
            </Button>
          ))}
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
        {(order.status === 'pending' || order.status === 'paid') &&
          (reducing ? (
            <ReduceForm order={order} actions={actions} onClose={() => setReducing(false)} />
          ) : (
            <Button stretched mode="bezeled" onClick={() => setReducing(true)}>
              {t('reduce.open')}
            </Button>
          ))}
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

/**
 * Carrier and tracking, right where the order is marked as shipped (both
 * optional). The carriers used before in this GB are a tap away.
 */
function ShipForm({
  order,
  confirmLabel,
  onCancel,
  onSave,
}: {
  order: Order;
  confirmLabel: string;
  onCancel: () => void;
  onSave: (shipment: { carrier: string; trackingNumber: string }) => Promise<unknown> | void;
}): React.JSX.Element {
  const carriers = useAsync(() => api.adminCarriers(), []);
  const [carrier, setCarrier] = useState(order.carrier ?? '');
  const [tracking, setTracking] = useState(order.trackingNumber ?? '');
  const suggested = carriers.data ?? [];
  // The last carrier used, ready, when shipping (not when correcting an older shipment).
  const last = suggested[0];
  useEffect(() => {
    if (order.status === 'paid' && !order.carrier && last) setCarrier((current) => current || last);
  }, [order.status, order.carrier, last]);
  return (
    <div className="gb-ship-form">
      <Input
        header={t('actions.carrier')}
        placeholder={t('actions.carrierPlaceholder')}
        value={carrier}
        maxLength={60}
        onChange={(e) => setCarrier(e.target.value)}
      />
      {suggested.length > 0 && (
        <div className="gb-chips gb-ship-carriers">
          {suggested.map((name) => (
            <button
              key={name}
              type="button"
              className={`gb-chip ${name === carrier ? 'gb-chip--info' : ''}`}
              onClick={() => setCarrier(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <Input
        header={t('actions.tracking')}
        placeholder={t('actions.trackingPlaceholder')}
        value={tracking}
        maxLength={200}
        onChange={(e) => setTracking(e.target.value)}
      />
      <div className="gb-ship-form-buttons">
        <Button
          stretched
          mode="filled"
          onClick={() => void onSave({ carrier: carrier.trim(), trackingNumber: tracking.trim() })}
        >
          {confirmLabel}
        </Button>
        <Button stretched mode="plain" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Taking products out of an order (sold out…), or lowering quantities: only
 * down, with a reason the customer gets. What is left keeps its price.
 */
function ReduceForm({
  order,
  actions,
  onClose,
}: {
  order: Order;
  actions: AdminActions;
  onClose: () => void;
}): React.JSX.Element {
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(order.items.map((item) => [itemKey(item), item.quantity])),
  );
  const [reason, setReason] = useState('');
  const money = (amount: number): string => formatPrice(amount, order.currency);
  const quantity = (item: Order['items'][number]): number => quantities[itemKey(item)] ?? item.quantity;
  const removedValue = order.items.reduce((sum, item) => sum + (item.quantity - quantity(item)) * item.unitPrice, 0);
  const left = order.items.some((item) => quantity(item) > 0);
  // The server's figures (testings dropped included); a local estimate meanwhile.
  const [preview, setPreview] = useState<ReducePreview | null>(null);
  const linesKey = order.items.map((item) => `${itemKey(item)}:${quantity(item)}`).join('|');
  useEffect(() => {
    setPreview(null);
    if (removedValue === 0 || !left) return;
    const timer = setTimeout(() => {
      void api
        .adminReducePreview(
          order.id,
          order.items.map((item) => ({ productId: item.productId, variantId: item.variantId, quantity: quantity(item) })),
        )
        .then(setPreview)
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);
  const newTotal = preview?.total ?? order.total - removedValue;
  const refund = preview ? -preview.amountDue : order.amountPaid - newTotal;
  const testingBack = preview?.testingBack ?? 0;
  const set = (item: Order['items'][number], value: number): void =>
    setQuantities({ ...quantities, [itemKey(item)]: Math.max(0, Math.min(item.quantity, value)) });

  return (
    <div className="gb-reduce-form">
      {order.items.map((item) => {
        const value = quantity(item);
        return (
          <Cell
            key={itemKey(item)}
            multiline
            subtitle={value < item.quantity ? t('reduce.was', { quantity: item.quantity }) : money(item.unitPrice)}
            after={
              <div className="gb-reduce-stepper">
                <Button size="s" mode="bezeled" disabled={value === 0} onClick={() => set(item, value - 1)}>
                  −
                </Button>
                <span className={value < item.quantity ? 'gb-reduce-changed' : undefined}>{value}</span>
                <Button size="s" mode="bezeled" disabled={value === item.quantity} onClick={() => set(item, value + 1)}>
                  +
                </Button>
              </div>
            }
          >
            <span style={{ textDecoration: value === 0 ? 'line-through' : undefined }}>{itemName(item)}</span>
          </Cell>
        );
      })}
      <Textarea
        header={t('reduce.reason')}
        placeholder={t('reduce.reasonPlaceholder')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {removedValue > 0 && (
        <Cell multiline>
          {!left
            ? t('reduce.nothingLeft')
            : order.amountPaid > 0 && refund > 0
              ? testingBack > 0
                ? t('reduce.previewRefundTesting', {
                    total: money(newTotal),
                    refund: money(refund),
                    testing: money(testingBack),
                  })
                : t('reduce.previewRefund', { total: money(newTotal), refund: money(refund) })
              : t('reduce.previewTotal', { total: money(newTotal) })}
        </Cell>
      )}
      <div className="gb-reduce-buttons">
        <Button
          stretched
          mode="filled"
          disabled={removedValue === 0 || !left || reason.trim() === ''}
          onClick={() =>
            void actions.twoTap(`reduce:${order.id}`, async () => {
              await api.adminReduceOrder(
                order.id,
                order.items.map((item) => ({
                  productId: item.productId,
                  variantId: item.variantId,
                  quantity: quantity(item),
                })),
                reason.trim(),
              );
              onClose();
            })
          }
        >
          {actions.tapLabel(`reduce:${order.id}`, t('reduce.apply'))}
        </Button>
        <Button stretched mode="plain" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
