import { Fragment, useCallback, useState } from 'react';
import { awaitsPayment, shippingCost, type DeliveryAddress } from '@tma-shop/shared';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../components/Field.js';
import { api, ApiClientError } from '../api/client.js';
import { useCart } from '../providers/CartProvider.js';
import { useSession } from '../providers/SessionProvider.js';
import { useMainButton } from '../hooks/useMainButton.js';
import { formatPrice } from '../lib/format.js';
import { convertedPrice, otherPayment } from '../lib/exchange.js';
import { lineName } from '../lib/variants.js';
import { useAsync } from '../hooks/useAsync.js';
import { Loader } from '../components/Loader.js';
import { useShop, useShopPath } from '../providers/ShopProvider.js';
import {
  AddressForm,
  addressComplete,
  EMPTY_ADDRESS,
  trimAddress,
} from '../components/AddressForm.js';
import {
  cryptoAvailable,
  encryptAddress,
  loadSavedAddress,
  saveAddress,
} from '../lib/addressCrypto.js';
import { askWriteAccess } from '../lib/writeAccess.js';
import { productTitle } from '../lib/localize.js';
import { t } from '../i18n/index.js';

export function CartPage(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const closed = useShop().shop.isClosed;
  const { cart, loading, setQuantity, remove, refresh } = useCart();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useSession();
  // Pre-filled with the customer's Telegram @username when they have one.
  const [contact, setContact] = useState(user?.username ? `@${user.username}` : '');
  const contactName = contact.trim().replace(/^@/, '');
  const contactValid = /^[A-Za-z0-9_]{5,32}$/.test(contactName);
  const shop = useAsync(() => api.getShop(), []);
  // An order already waiting for payment: warn before placing a second one.
  const myOrders = useAsync(() => api.getOrders(), []);
  const unpaid = (myOrders.data ?? []).filter(awaitsPayment);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const [duplicateOk, setDuplicateOk] = useState(false);

  // Shipping: shops with active zones ask for a zone and a delivery address.
  const zones = (shop.data?.shippingZones ?? []).filter((z) => z.isActive);
  const needsShipping = zones.length > 0;
  const [zoneId, setZoneId] = useState<string | null>(null);
  const zone = zones.find((z) => z.id === zoneId) ?? (zones.length === 1 ? zones[0] : undefined);
  const [address, setAddress] = useState<DeliveryAddress>(() => {
    const saved = loadSavedAddress();
    if (saved) return { ...EMPTY_ADDRESS, ...saved };
    const name = user?.firstName ?? '';
    return { ...EMPTY_ADDRESS, name };
  });
  const [remember, setRemember] = useState(true);
  const itemsTotal = cart ? cart.total - cart.fee : 0;
  // Products below their minimum (all variants together): checkout waits.
  const shortfalls = (() => {
    const byProduct = new Map<string, { name: string; min: number; quantity: number }>();
    for (const line of cart?.lines ?? []) {
      const entry = byProduct.get(line.product.id) ?? {
        name: productTitle(line.product),
        min: line.product.minQuantity,
        quantity: 0,
      };
      entry.quantity += line.quantity;
      byProduct.set(line.product.id, entry);
    }
    return [...byProduct.values()].filter((p) => p.quantity < p.min);
  })();
  // VIPs may not pay shipping in this GB.
  const vipFreeShipping = (cart?.isVip ?? false) && (shop.data?.vipNoShipping ?? false);
  const shipping = zone ? shippingCost(zone, itemsTotal, vipFreeShipping) : 0;
  const grandTotal = (cart?.total ?? 0) + shipping;
  // The GB's minimum: how far it would get with this order (when amounts are shown).
  const goal = shop.data?.goal ?? null;
  const goalAfter =
    goal && !goal.reached && goal.target !== null && goal.ordered !== null && cart && cart.lines.length > 0
      ? Math.floor(((goal.ordered + itemsTotal) * 100) / goal.target)
      : null;
  // For information: the total in the other token, if the GB lets you pay with it.
  const other = shop.data && cart ? otherPayment(shop.data, cart.currency) : null;
  // A price, with its value in the other token underneath (for information).
  const money = (amount: number): React.ReactNode =>
    cart && other ? (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <span>{formatPrice(amount, cart.currency)}</span>
        <span style={{ fontSize: 12, opacity: 0.6 }}>≈ {convertedPrice(amount, other)}</span>
      </span>
    ) : cart ? (
      formatPrice(amount, cart.currency)
    ) : (
      ''
    );
  const checkout = useCallback(async (force = false) => {
    if (!force && !duplicateOk && unpaid.length > 0) {
      setDuplicateWarning(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setDuplicateWarning(false);
    setBusy(true);
    setError(null);
    // What is missing is said at the top of the page, where the message is.
    const missing = (message: string): void => {
      setError(message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    try {
      if (shortfalls.length > 0) {
        missing(t('cart.belowMinimum'));
        return;
      }
      if (!contactValid) {
        missing(t('cart.needUsername'));
        return;
      }
      let shippingDetails: { shippingZoneId: string; encryptedAddress: string } | null = null;
      if (needsShipping) {
        const config = shop.data;
        if (!zone) {
          missing(t('cart.needZone'));
          return;
        }
        if (!addressComplete(address)) {
          missing(t('cart.needAddress'));
          return;
        }
        if (!config?.addressPublicKey || !config.addressKeyFingerprint || !cryptoAvailable()) {
          missing(t('cart.noDeliveryYet'));
          return;
        }
        const clean = trimAddress(address);
        shippingDetails = {
          shippingZoneId: zone.id,
          encryptedAddress: await encryptAddress(
            clean,
            config.addressPublicKey,
            config.addressKeyFingerprint,
          ),
        };
        // Remembered only on this phone, to prefill the next order.
        saveAddress(remember ? clean : null);
      }
      const { orderId } = await api.createOrder(contactName, shippingDetails);
      // The server empties the cart when it creates the order.
      void refresh();
      // So the bot can tell the customer how the order goes.
      void askWriteAccess();
      // Show the wallets and collect the transaction hash.
      navigate(to(`/orders/${orderId}`), { replace: true });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('cart.checkoutFailed'));
    } finally {
      setBusy(false);
    }
  }, [
    navigate,
    to,
    refresh,
    contactValid,
    contactName,
    needsShipping,
    shop.data,
    zone,
    address,
    remember,
    unpaid.length,
    duplicateOk,
    shortfalls.length,
  ]);

  const hasItems = (cart?.lines.length ?? 0) > 0;
  const onCheckout = useCallback(() => void checkout(), [checkout]);

  useMainButton({
    text: cart
      ? t('cart.checkoutTotal', { total: formatPrice(grandTotal, cart.currency) })
      : t('cart.checkout'),
    visible: hasItems && !closed,
    // Wait for the shop config so checkout never picks the wrong payment flow.
    // Otherwise always pressable: if something is missing, tapping says what.
    enabled: shop.data !== null,
    loading: busy || shop.loading,
    onClick: onCheckout,
  });

  if (loading && !cart) return <Loader />;

  if (closed) {
    return (
      <Placeholder header={t('closed.title')} description={t('closed.hint')}>
        <span style={{ fontSize: 48 }}>🔒</span>
      </Placeholder>
    );
  }

  if (!hasItems) {
    return (
      <Placeholder header={t('cart.empty')} description={t('cart.emptyHint')}>
        <span style={{ fontSize: 48 }}>🛒</span>
      </Placeholder>
    );
  }

  const firstUnpaid = unpaid[0];
  // Where the customer is: what is done, and what the button will ask for next.
  const steps = [
    { label: t('cart.stepReview'), done: hasItems && shortfalls.length === 0 },
    ...(needsShipping
      ? [{ label: t('cart.stepShipping'), done: zone !== undefined && addressComplete(address) }]
      : []),
    { label: t('cart.stepContact'), done: contactValid },
  ];

  return (
    <List>
      {duplicateWarning && firstUnpaid && (
        <Section header={t('cart.duplicateTitle')}>
          <Cell multiline>
            {unpaid.length === 1
              ? t('cart.duplicateOne', {
                  id: firstUnpaid.id.slice(0, 8),
                  amount: formatPrice(firstUnpaid.amountDue, firstUnpaid.currency),
                })
              : t('cart.duplicateMany', { count: unpaid.length })}
          </Cell>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px 16px' }}>
            <Button
              stretched
              onClick={() =>
                navigate(to(unpaid.length === 1 ? `/orders/${firstUnpaid.id}` : '/orders'))
              }
            >
              {unpaid.length === 1 ? t('cart.duplicatePay') : t('cart.duplicateSee')}
            </Button>
            <Button
              stretched
              mode="bezeled"
              onClick={() => {
                setDuplicateOk(true);
                void checkout(true);
              }}
            >
              {t('cart.duplicateContinue')}
            </Button>
          </div>
        </Section>
      )}
      {(error ?? shop.error) && (
        <Section>
          <Cell multiline style={{ color: 'var(--tgui--destructive_text_color)' }}>
            {error ?? shop.error}
          </Cell>
        </Section>
      )}
      {shortfalls.length > 0 && (
        <Section header={t('cart.minimumTitle')}>
          {shortfalls.map((s) => (
            <Cell key={s.name} multiline style={{ color: 'var(--tgui--destructive_text_color)' }}>
              {t('cart.minimumLine', { name: s.name, min: s.min, quantity: s.quantity })}
            </Cell>
          ))}
        </Section>
      )}
      <CartSteps steps={steps} />
      <Section header={`1 · ${t('cart.title')}`}>
        {cart?.lines.map((line) => (
          <Cell
            key={line.id}
            subtitle={formatPrice(line.unitPrice, cart.currency)}
            after={money(line.subtotal)}
            description={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                <Button
                  size="s"
                  mode="bezeled"
                  onClick={() => void setQuantity(line.id, line.quantity - 1)}
                >
                  −
                </Button>
                <span>{line.quantity}</span>
                <Button
                  size="s"
                  mode="bezeled"
                  onClick={() => void setQuantity(line.id, line.quantity + 1)}
                >
                  +
                </Button>
                <Button size="s" mode="plain" onClick={() => void remove(line.id)}>
                  {t('cart.remove')}
                </Button>
              </div>
            }
            multiline
          >
            {lineName(productTitle(line.product), line.variant?.label)}
          </Cell>
        ))}
      </Section>
      <Section>
        {cart?.isVip && <Cell multiline>{t('cart.vip')}</Cell>}
        {cart && cart.fee > 0 && (
          <Cell after={money(cart.fee)}>
            {shop.data?.orderFeeLabel ?? t('cart.serviceFee')}
          </Cell>
        )}
        {needsShipping && (
          <Cell after={zone && cart ? money(shipping) : '—'}>
            {zone ? t('cart.shippingZoneLine', { zone: zone.name }) : t('cart.shipping')}
          </Cell>
        )}
        <Cell after={cart ? formatPrice(grandTotal, cart.currency) : ''}>{t('cart.total')}</Cell>
        {goalAfter !== null && <Cell multiline>{t('goal.withYourOrder', { percent: goalAfter })}</Cell>}
        {other && cart && cart.lines.length > 0 && (
          <Cell multiline subtitle={t('exchange.choose', { a: cart.currency, b: other.token })}>
            {t('exchange.total', { price: convertedPrice(grandTotal, other) })}
          </Cell>
        )}
      </Section>
      {needsShipping && cart && (
        <Section header={`2 · ${t('cart.shippingZone')}`}>
          {zones.map((z) => {
            const cost = shippingCost(z, itemsTotal, vipFreeShipping);
            return (
              <Cell
                key={z.id}
                onClick={() => setZoneId(z.id)}
                subtitle={
                  z.freeFrom !== null
                    ? t('cart.freeFrom', {
                        amount:
                          formatPrice(z.freeFrom, cart.currency) +
                          (other ? ` (≈ ${convertedPrice(z.freeFrom, other)})` : ''),
                      })
                    : undefined
                }
                after={
                  <span>
                    {cost === 0 ? t('cart.free') : money(cost)}
                    {zone?.id === z.id ? ' ✓' : ''}
                  </span>
                }
              >
                {z.name}
              </Cell>
            );
          })}
        </Section>
      )}
      {needsShipping && (
        <>
          <AddressForm value={address} onChange={setAddress} />
          <Section>
            <Cell
              onClick={() => setRemember((r) => !r)}
              after={remember ? '✓' : ''}
              multiline
            >
              {t('cart.rememberAddress')}
            </Cell>
          </Section>
        </>
      )}
      <Section
        header={`${needsShipping ? 3 : 2} · ${t('cart.usernameSection')}`}
        footer={contactValid ? t('cart.usernameOk') : t('cart.usernameRule')}
      >
        <Input
          header={t('cart.usernameField')}
          placeholder={t('cart.usernamePlaceholder')}
          status={contact.trim() === '' || contactValid ? 'default' : 'error'}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        />
      </Section>
    </List>
  );
}

/** 1 Review → 2 Shipping → 3 Contact: done ones in green, the current one highlighted. */
function CartSteps({
  steps,
}: {
  steps: Array<{ label: string; done: boolean }>;
}): React.JSX.Element {
  const current = steps.findIndex((step) => !step.done);
  return (
    <div className="gb-steps">
      {steps.map((step, i) => (
        <Fragment key={step.label}>
          {i > 0 && (
            <span
              className={steps[i - 1]?.done ? 'gb-step-line gb-step-line--done' : 'gb-step-line'}
            />
          )}
          <span
            className={
              step.done
                ? 'gb-step-dot gb-step-dot--done'
                : i === current
                  ? 'gb-step-dot gb-step-dot--now'
                  : 'gb-step-dot'
            }
          >
            {step.done ? '✓' : i + 1}
          </span>
          <span className={i === current ? 'gb-step--now' : undefined}>{step.label}</span>
        </Fragment>
      ))}
    </div>
  );
}
