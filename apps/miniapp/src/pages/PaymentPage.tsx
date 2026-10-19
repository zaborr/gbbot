import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../components/Field.js';
import {
  RATE_SCALE,
  convertAmount,
  editableDirectly,
  exchangeRateFor,
  payBefore,
  shippingCost,
  unitPriceFor,
  type ExchangeRates,
  type ManualMethodView,
  type Order,
  type PaymentMethod,
  type ShippingZone,
} from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useMainButton } from '../hooks/useMainButton.js';
import { useLiveRefresh } from '../hooks/useLiveRefresh.js';
import { copyText } from '../lib/clipboard.js';
import { formatFiat, formatPrice, formatTokenAmount } from '../lib/format.js';
import { activeVariants, hasVariants, itemKey, customerItemName, vipPriceFor } from '../lib/variants.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { useShopPath } from '../providers/ShopProvider.js';
import { TrackingText } from '../components/TrackingText.js';
import { locale, t } from '../i18n/index.js';

const breakAll: React.CSSProperties = { wordBreak: 'break-all', whiteSpace: 'normal' };
const errorStyle: React.CSSProperties = { color: 'var(--tgui--destructive_text_color)' };

/** Statuses whose order a customer can ask to modify (needs admin approval). */
const CHANGEABLE: Order['status'][] = ['paid', 'awaiting_payment'];

type Done = 'payment' | 'change' | null;

/**
 * Order detail: items and amounts, crypto checkout (pick a wallet, send what is
 * due, paste the tx hash) and change requests on paid orders.
 */
export function PaymentPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const to = useShopPath();
  const [reloadKey, setReloadKey] = useState(0);
  const [done, setDone] = useState<Done>(null);
  const [editing, setEditing] = useState(false);
  const order = useAsync(() => api.getOrder(id), [id, reloadKey]);
  const shop = useAsync(() => api.getShop(), []);

  const current = order.data;
  const needsPayment =
    current !== null &&
    (current.status === 'pending' || current.status === 'awaiting_payment') &&
    current.amountDue > 0 &&
    done !== 'payment';

  // When nothing is left to do here, the main button takes the customer back.
  useMainButton({
    text: t('order.backToShop'),
    visible: current !== null && !needsPayment && !editing,
    onClick: () => navigate(to('/')),
  });

  // While the blockchain check runs, follow it live; and refresh when the
  // customer comes back from reading the bot's message.
  useLiveRefresh(
    () => setReloadKey((k) => k + 1),
    current?.paymentCheck?.status === 'checking',
  );

  // Refreshes keep showing the order instead of flashing a spinner.
  if ((order.loading && !order.data) || (shop.loading && !shop.data)) return <Loader />;
  if (order.error) return <ErrorView message={order.error} />;
  if (shop.error) return <ErrorView message={shop.error} />;
  if (!current || !shop.data) return <Loader />;

  // Nothing paid or sent yet: the customer edits the order directly.
  const direct = editableDirectly(current);
  // A closed GB takes no changes, and only the difference left on paid orders.
  const closed = shop.data.isClosed;
  const canPay = !closed || current.amountPaid > 0;
  // Pay in the order's token (USDC/EURC), or in the other one at the GB's rate.
  const rates = shop.data.exchangeRates;
  const methods = shop.data.paymentMethods
    .filter((m) => exchangeRateFor(rates, current.currency, m.token) !== null)
    .sort((a, b) => Number(b.token === current.currency) - Number(a.token === current.currency));
  // And other ways (Wise, Bizum…) that an admin checks by hand.
  const manual = shop.data.manualMethods;
  const anyMethod = methods.length > 0 || manual.length > 0;
  const reload = (): void => setReloadKey((k) => k + 1);
  const feeLabel = shop.data.orderFeeLabel;

  return (
    <List>
      {done && <DoneSection kind={done} onShop={() => navigate(to('/'))} onOrders={() => navigate(to('/orders'))} />}

      <Section header={t('orders.orderNumber', { id: current.id.slice(0, 8) })}>
        {current.items.map((item) => (
          <Cell
            key={itemKey(item)}
            after={formatPrice(item.subtotal, current.currency)}
            subtitle={`${item.quantity} × ${formatPrice(item.unitPrice, current.currency)}`}
          >
            {customerItemName(item)}
          </Cell>
        ))}
        {current.fee > 0 && (
          <Cell after={formatPrice(current.fee, current.currency)}>{feeLabel}</Cell>
        )}
        {current.shippingZoneName && (
          <Cell
            after={
              current.shipping > 0 ? formatPrice(current.shipping, current.currency) : t('cart.free')
            }
          >
            {t('cart.shippingZoneLine', { zone: current.shippingZoneName })}
          </Cell>
        )}
        <Cell after={formatPrice(current.total, current.currency)}>{t('cart.total')}</Cell>
        {current.amountPaid > 0 && (
          <Cell after={formatPrice(current.amountPaid, current.currency)}>{t('order.paidSoFar')}</Cell>
        )}
        {current.amountPaid > 0 && current.amountDue > 0 && (
          <Cell after={formatPrice(current.amountDue, current.currency)}>{t('orders.differenceToPay')}</Cell>
        )}
        {current.amountDue < 0 && (
          <Cell after={formatPrice(-current.amountDue, current.currency)}>{t('order.refund')}</Cell>
        )}
        {current.contactUsername && (
          <Cell after={`@${current.contactUsername}`}>{t('order.contact')}</Cell>
        )}
      </Section>

      {!done && <StatusSection order={current} autoCancelHours={shop.data.autoCancelHours} />}

      {needsPayment && canPay && !editing && anyMethod && (
        <PaymentForm
          key={`${current.paymentTxHash ?? 'new'}-${current.amountDue}`}
          order={current}
          methods={methods}
          rates={rates}
          manual={manual}
          onSubmitted={() => {
            setDone('payment');
            reload();
          }}
        />
      )}
      {needsPayment && canPay && !anyMethod && (
        <Placeholder
          header={t('order.noWallet', { currency: current.currency })}
          description={t('order.noWalletHint')}
        >
          <span style={{ fontSize: 48 }}>💳</span>
        </Placeholder>
      )}

      {current.changeRequest ? (
        <PendingChange order={current} feeLabel={feeLabel} onWithdrawn={reload} />
      ) : (
        !closed &&
        (direct || CHANGEABLE.includes(current.status)) &&
        (editing ? (
          <ChangeEditor
            order={current}
            feeLabel={feeLabel}
            direct={direct}
            zones={shop.data.shippingZones}
            onCancel={() => setEditing(false)}
            onRequested={() => {
              setEditing(false);
              // An unpaid order changes at once; a paid one waits for approval.
              if (!direct) setDone('change');
              reload();
            }}
          />
        ) : (
          <Section footer={direct ? t('order.editFooter') : t('order.changeFooter')}>
            <div style={{ padding: 16 }}>
              <Button stretched mode="bezeled" onClick={() => setEditing(true)}>
                {direct ? t('order.edit') : t('order.requestChange')}
              </Button>
            </div>
          </Section>
        ))
      )}
    </List>
  );
}

function DoneSection({
  kind,
  onShop,
  onOrders,
}: {
  kind: 'payment' | 'change';
  onShop: () => void;
  onOrders: () => void;
}): React.JSX.Element {
  return (
    <Section>
      <Placeholder
        header={kind === 'payment' ? t('order.paymentSent') : t('order.changeSent')}
        description={kind === 'payment' ? t('order.paymentSentHint') : t('order.changeSentHint')}
      >
        <span style={{ fontSize: 56 }}>✅</span>
      </Placeholder>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px 16px' }}>
        <Button stretched onClick={onShop}>
          {t('order.backToShop')}
        </Button>
        <Button stretched mode="plain" onClick={onOrders}>
          {t('orders.title')}
        </Button>
      </div>
    </Section>
  );
}

function StatusSection({
  order,
  autoCancelHours,
}: {
  order: Order;
  autoCancelHours: number;
}): React.JSX.Element {
  const deadline = payBefore(order, autoCancelHours);
  return (
    <>
      <StatusDetail order={order} />
      {deadline && (
        <Section>
          <Cell multiline>
            {t('order.payBefore', {
              date: deadline.toLocaleString(locale(), {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </Cell>
        </Section>
      )}
      {order.statusNote && (
        <Section header={t('order.shopMessage')}>
          <Cell multiline>{order.statusNote}</Cell>
        </Section>
      )}
    </>
  );
}

function StatusDetail({ order }: { order: Order }): React.JSX.Element {
  const money = (amount: number): string => formatPrice(amount, order.currency);
  switch (order.status) {
    case 'awaiting_payment':
      return (
        <Section
          header={t('order.paymentSubmitted')}
          footer={
            order.paymentManual
              ? t('order.manualSubmittedHint')
              : order.paymentCheck?.status === 'failed'
                ? t('order.checkFailedHint')
                : order.paymentCheck?.status === 'checking'
                  ? t('order.checkingHint')
                  : t('order.paymentSubmittedHint')
          }
        >
          <Cell subtitle={t('order.method')}>{order.paymentNetwork ?? '—'}</Cell>
          <Cell subtitle={order.paymentManual ? t('order.reference') : t('order.transaction')} multiline>
            {order.paymentTxUrl ? (
              <a href={order.paymentTxUrl} target="_blank" rel="noreferrer" style={breakAll}>
                {order.paymentTxHash}
              </a>
            ) : (
              <span style={breakAll}>{order.paymentTxHash ?? '—'}</span>
            )}
          </Cell>
        </Section>
      );
    case 'paid':
      return (
        <Section>
          <Cell multiline>
            {order.amountDue < 0
              ? t('order.confirmedRefund')
              : t('order.confirmed')}
          </Cell>
        </Section>
      );
    case 'shipped':
      return (
        <Section>
          <Cell multiline>{t('order.onItsWay')}</Cell>
          {order.trackingNumber && (
            <Cell subtitle={t('order.tracking')} multiline>
              <TrackingText value={order.trackingNumber} />
            </Cell>
          )}
        </Section>
      );
    case 'fulfilled':
      return (
        <Section>
          <Cell>{t('order.delivered')}</Cell>
          {order.trackingNumber && (
            <Cell subtitle={t('order.tracking')} multiline>
              <TrackingText value={order.trackingNumber} />
            </Cell>
          )}
        </Section>
      );
    case 'cancelled':
      return (
        <Section>
          <Cell multiline>
            {order.amountDue < 0
              ? t('order.cancelledRefund', { amount: money(-order.amountDue) })
              : t('order.cancelled')}
          </Cell>
        </Section>
      );
    case 'pending':
      return order.amountPaid > 0 ? (
        <Section>
          <Cell multiline>{t('order.payRest')}</Cell>
        </Section>
      ) : (
        <></>
      );
  }
}

function PaymentForm({
  order,
  methods,
  rates,
  manual,
  onSubmitted,
}: {
  order: Order;
  methods: PaymentMethod[];
  rates: ExchangeRates;
  manual: ManualMethodView[];
  onSubmitted: () => void;
}): React.JSX.Element {
  // Crypto ids ("usdc-base") and manual ones ("manual:<id>") in one choice.
  const choices = [
    ...methods.map((m) => ({
      key: m.id,
      label:
        t('order.tokenOn', { token: m.token, network: m.network }) +
        (m.token === order.currency ? '' : ` · ${t('order.exchanged')}`),
    })),
    ...manual.map((m) => ({ key: `manual:${m.id}`, label: m.name })),
  ];
  const [choice, setChoice] = useState(choices[0]?.key ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = choices.some((c) => c.key === choice) ? choice : (choices[0]?.key ?? '');
  const crypto = methods.find((m) => m.id === selected);
  const manualMethod = manual.find((m) => `manual:${m.id}` === selected);
  const resubmit = order.status === 'awaiting_payment';

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('order.submitFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section header={resubmit ? t('order.resubmitAny') : t('order.step1')}>
        {choices.map((c) => (
          <Cell key={c.key} onClick={() => setChoice(c.key)} after={c.key === selected ? '✓' : ''}>
            {c.label}
          </Cell>
        ))}
      </Section>

      {crypto && (
        <CryptoSteps
          key={crypto.id}
          order={order}
          method={crypto}
          rate={exchangeRateFor(rates, order.currency, crypto.token) ?? RATE_SCALE}
          busy={busy}
          error={error}
          run={run}
        />
      )}
      {manualMethod && (
        <ManualSteps
          key={manualMethod.id}
          order={order}
          method={manualMethod}
          busy={busy}
          error={error}
          run={run}
        />
      )}
    </>
  );
}

interface StepsProps {
  order: Order;
  busy: boolean;
  error: string | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

/** A value to copy, with its button. */
function CopyCell({
  label,
  value,
  copyValue,
  copied,
  onCopied,
  breakText = false,
}: {
  label: string;
  value: string;
  copyValue: string;
  copied: boolean;
  onCopied: () => void;
  breakText?: boolean;
}): React.JSX.Element {
  return (
    <Cell
      subtitle={label}
      multiline={breakText}
      after={
        <Button
          size="s"
          mode="bezeled"
          onClick={() =>
            void copyText(copyValue).then((ok) => {
              if (ok) onCopied();
            })
          }
        >
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      }
    >
      {breakText ? <span style={breakAll}>{value}</span> : value}
    </Cell>
  );
}

function ErrorLine({ error }: { error: string | null }): React.JSX.Element | null {
  return error ? (
    <Cell multiline style={errorStyle}>
      {error}
    </Cell>
  ) : null;
}

/** Crypto: send exactly the amount to the address, then paste the transaction hash. */
function CryptoSteps({
  order,
  method,
  rate,
  busy,
  error,
  run,
}: StepsProps & { method: PaymentMethod; rate: number }): React.JSX.Element {
  const [txHash, setTxHash] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  // In the other token: the amount at the GB's rate, rounded up.
  const exchanged = method.token !== order.currency;
  const due = exchanged ? convertAmount(order.amountDue, rate) : order.amountDue;
  const resubmit = order.status === 'awaiting_payment';

  return (
    <>
      <Section
        header={t('order.step2')}
        footer={t('order.step2Warning', { token: method.token, network: method.network })}
      >
        <CopyCell
          label={order.amountPaid > 0 ? t('orders.differenceToPay') : t('order.amount')}
          value={formatTokenAmount(due, method.token)}
          copyValue={(due / 100).toFixed(2)}
          copied={copied === 'amount'}
          onCopied={() => setCopied('amount')}
        />
        {exchanged && (
          <Cell multiline subtitle={t('order.exchangeRate', { from: order.currency, rate: rate / RATE_SCALE, to: method.token })}>
            {t('order.exchangeNote', { amount: formatTokenAmount(order.amountDue, order.currency) })}
          </Cell>
        )}
        <CopyCell
          label={t('order.networkAddress', { network: method.network })}
          value={method.address}
          copyValue={method.address}
          copied={copied === 'address'}
          onCopied={() => setCopied('address')}
          breakText
        />
      </Section>

      <Section header={t('order.step3')} footer={t('order.step3Hint')}>
        <Input
          header={t('order.txHash')}
          placeholder={t('order.txHashPlaceholder')}
          value={txHash}
          onChange={(e) => setTxHash(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={txHash.trim().length < 8}
            onClick={() => void run(() => api.submitPayment(order.id, method.id, txHash.trim()))}
          >
            {resubmit ? t('order.updateTx') : t('order.iHavePaid')}
          </Button>
          <ErrorLine error={error} />
        </div>
      </Section>
    </>
  );
}

/** Wise, Bizum…: follow the organiser's instructions, then say it is paid. */
function ManualSteps({
  order,
  method,
  busy,
  error,
  run,
}: StepsProps & { method: ManualMethodView }): React.JSX.Element {
  const [reference, setReference] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const due = order.amountDue;
  const orderNumber = order.id.slice(0, 8);
  const resubmit = order.status === 'awaiting_payment';

  return (
    <>
      <Section header={t('order.manualStep2', { method: method.name })}>
        <Cell multiline>
          <span style={{ whiteSpace: 'pre-wrap' }}>{method.instructions}</span>
        </Cell>
        <CopyCell
          label={order.amountPaid > 0 ? t('orders.differenceToPay') : t('order.amount')}
          value={formatFiat(due, order.currency)}
          copyValue={(due / 100).toFixed(2)}
          copied={copied === 'amount'}
          onCopied={() => setCopied('amount')}
        />
        <CopyCell
          label={t('order.manualConcept')}
          value={orderNumber}
          copyValue={orderNumber}
          copied={copied === 'concept'}
          onCopied={() => setCopied('concept')}
        />
      </Section>

      <Section header={t('order.manualStep3')} footer={t('order.manualStep3Hint')}>
        <Input
          header={t('order.manualReference')}
          placeholder={t('order.manualReferencePlaceholder')}
          value={reference}
          maxLength={200}
          onChange={(e) => setReference(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            onClick={() =>
              void run(() => api.submitManualPayment(order.id, method.id, reference.trim()))
            }
          >
            {resubmit ? t('order.updateManual') : t('order.iHavePaid')}
          </Button>
          <ErrorLine error={error} />
        </div>
      </Section>
    </>
  );
}

/** What the customer has already paid or sent for review, to compute the difference. */
function coveredAmount(order: Order): number {
  return order.amountPaid + order.amountSubmitted;
}

function differenceLabel(diff: number, currency: string): string {
  if (diff > 0) return t('change.payMore', { amount: formatPrice(diff, currency) });
  if (diff < 0) return t('change.getBack', { amount: formatPrice(-diff, currency) });
  return t('change.same');
}

function PendingChange({
  order,
  feeLabel,
  onWithdrawn,
}: {
  order: Order;
  feeLabel: string;
  onWithdrawn: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = order.changeRequest;
  if (!change) return <></>;

  const withdraw = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.withdrawOrderChange(order.id);
      onWithdrawn();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('change.withdrawFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      header={t('change.pending')}
      footer={differenceLabel(change.total - coveredAmount(order), order.currency)}
    >
      {change.items.map((item) => (
        <Cell
          key={itemKey(item)}
          after={formatPrice(item.subtotal, order.currency)}
          subtitle={`${item.quantity} × ${formatPrice(item.unitPrice, order.currency)}`}
        >
          {customerItemName(item)}
        </Cell>
      ))}
      {order.fee > 0 && <Cell after={formatPrice(order.fee, order.currency)}>{feeLabel}</Cell>}
      {order.shipping > 0 && (
        <Cell after={formatPrice(order.shipping, order.currency)}>{t('cart.shipping')}</Cell>
      )}
      <Cell after={formatPrice(change.total, order.currency)}>{t('change.newTotal')}</Cell>
      <div style={{ padding: 16 }}>
        <Button stretched mode="plain" loading={busy} onClick={() => void withdraw()}>
          {t('change.withdraw')}
        </Button>
        {error && (
          <Cell multiline style={errorStyle}>
            {error}
          </Cell>
        )}
      </div>
    </Section>
  );
}

interface DraftLine {
  productId: string;
  variantId: string | null;
  variantLabel: string | null;
  title: string;
  titleEn?: string | null | undefined;
  unitPrice: number;
  quantity: number;
}

/** Edit the order like a cart, then send it to the shop for approval. */
function ChangeEditor({
  order,
  feeLabel,
  direct,
  zones,
  onCancel,
  onRequested,
}: {
  order: Order;
  feeLabel: string;
  /** Unpaid order: saved at once instead of sent for approval. */
  direct: boolean;
  zones: ShippingZone[];
  onCancel: () => void;
  onRequested: () => void;
}): React.JSX.Element {
  const [lines, setLines] = useState<DraftLine[]>(() =>
    order.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      variantLabel: item.variantLabel,
      title: item.title,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalog = useAsync(() => api.getProducts({ limit: 150 }), []);

  const setQty = (key: string, quantity: number): void =>
    setLines((prev) =>
      quantity <= 0
        ? prev.filter((l) => itemKey(l) !== key)
        : prev.map((l) => (itemKey(l) === key ? { ...l, quantity } : l)),
    );

  // The order's fee is charged once, whatever the items.
  // Same rule as the shop: a product whose total quantity is unchanged keeps the
  // prices paid; otherwise all its lines get the current tier price.
  const products = new Map((catalog.data?.items ?? []).map((p) => [p.id, p]));
  const sumByProduct = (list: ReadonlyArray<{ productId: string; quantity: number }>) =>
    list.reduce(
      (acc, l) => acc.set(l.productId, (acc.get(l.productId) ?? 0) + l.quantity),
      new Map<string, number>(),
    );
  const oldQty = sumByProduct(order.items);
  const newQty = sumByProduct(lines);
  const priced = lines.map((line) => {
    const product = products.get(line.productId);
    const paid = order.items.find((i) => itemKey(i) === itemKey(line));
    if (!product) return line;
    if (paid && oldQty.get(line.productId) === newQty.get(line.productId)) {
      return { ...line, unitPrice: paid.unitPrice };
    }
    const variant = product.variants.find((v) => v.id === line.variantId) ?? null;
    return {
      ...line,
      unitPrice: unitPriceFor(
        product.price,
        variant?.priceOverride ?? null,
        product.priceTiers,
        newQty.get(line.productId) ?? line.quantity,
        // A VIP order keeps VIP prices when it changes.
        vipPriceFor(product, variant, order.isVip),
      ),
    };
  });
  const itemsTotal = priced.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  // The fee is charged once per order. Shipping stays as it was, except for an
  // unpaid order, where it follows the zone again (free shipping threshold).
  const zone = direct ? zones.find((z) => z.name === order.shippingZoneName) : undefined;
  const shipping = zone ? shippingCost(zone, itemsTotal) : order.shipping;
  const total = itemsTotal + order.fee + shipping;
  const diff = total - coveredAmount(order);
  // One addable entry per product, or per variant for products with options.
  const addable: DraftLine[] = (catalog.data?.items ?? [])
    .filter((p) => p.currency === order.currency)
    .flatMap((p): DraftLine[] =>
      hasVariants(p)
        ? activeVariants(p)
            .filter((v) => v.stock === null || v.stock > 0)
            .map((v) => ({
              productId: p.id,
              variantId: v.id,
              variantLabel: v.label,
              title: p.title,
              titleEn: p.titleEn,
              unitPrice: vipPriceFor(p, v, order.isVip) ?? v.price,
              quantity: 1,
            }))
        : p.stock === null || p.stock > 0
          ? [
              {
                productId: p.id,
                variantId: null,
                variantLabel: null,
                title: p.title,
                titleEn: p.titleEn,
                unitPrice: vipPriceFor(p, null, order.isVip) ?? p.price,
                quantity: 1,
              },
            ]
          : [],
    )
    .filter((candidate) => !lines.some((l) => itemKey(l) === itemKey(candidate)));

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.requestOrderChange(
        order.id,
        lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
        })),
      );
      onRequested();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('change.sendFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        header={direct ? t('order.edit') : t('change.title')}
        footer={direct ? undefined : differenceLabel(diff, order.currency)}
      >
        {lines.length === 0 && <Cell multiline>{t('change.keepOne')}</Cell>}
        {priced.map((line) => (
          <Cell
            key={itemKey(line)}
            subtitle={formatPrice(line.unitPrice, order.currency)}
            after={formatPrice(line.unitPrice * line.quantity, order.currency)}
            multiline
            description={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                <Button
                  size="s"
                  mode="bezeled"
                  onClick={() => setQty(itemKey(line), line.quantity - 1)}
                >
                  −
                </Button>
                <span>{line.quantity}</span>
                <Button
                  size="s"
                  mode="bezeled"
                  onClick={() => setQty(itemKey(line), line.quantity + 1)}
                >
                  +
                </Button>
                <Button size="s" mode="plain" onClick={() => setQty(itemKey(line), 0)}>
                  {t('cart.remove')}
                </Button>
              </div>
            }
          >
            {customerItemName(line)}
          </Cell>
        ))}
        {order.fee > 0 && (
          <Cell after={formatPrice(order.fee, order.currency)}>{feeLabel}</Cell>
        )}
        {(order.shipping > 0 || shipping > 0) && (
          <Cell after={shipping > 0 ? formatPrice(shipping, order.currency) : t('cart.free')}>
            {t('cart.shipping')}
          </Cell>
        )}
        <Cell after={formatPrice(total, order.currency)}>{t('change.newTotal')}</Cell>
      </Section>

      {addable.length > 0 && (
        <Section header={t('change.addProducts')}>
          {addable.map((candidate) => (
            <Cell
              key={itemKey(candidate)}
              subtitle={formatPrice(candidate.unitPrice, order.currency)}
              after={
                <Button
                  size="s"
                  mode="bezeled"
                  onClick={() => setLines((prev) => [...prev, candidate])}
                >
                  {t('common.add')}
                </Button>
              }
              multiline
            >
              {customerItemName(candidate)}
            </Cell>
          ))}
        </Section>
      )}

      <Section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={lines.length === 0}
            onClick={() => void submit()}
          >
            {direct ? t('change.save') : t('change.send')}
          </Button>
          <Button stretched mode="plain" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {error && (
            <Cell multiline style={errorStyle}>
              {error}
            </Cell>
          )}
        </div>
      </Section>
    </>
  );
}
