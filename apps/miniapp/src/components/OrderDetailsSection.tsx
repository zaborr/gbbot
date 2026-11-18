import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import { mergeDelivery, type DeliveryAddress, type DeliveryExtra, type Order, type ShopConfig } from '@tma-shop/shared';
import { Input, Textarea } from './Field.js';
import { EMAIL_RE } from './AddressForm.js';
import { api, ApiClientError } from '../api/client.js';
import { cryptoAvailable, encryptAddress, loadOrderDetails, saveOrderDetails } from '../lib/addressCrypto.js';
import { t } from '../i18n/index.js';

/** Order states where details can still be added (not sent yet). */
const OPEN: readonly Order['status'][] = ['pending', 'awaiting_payment', 'paid'];

function lines(a: DeliveryAddress): string[] {
  return [
    a.name,
    a.line1,
    a.line2,
    [a.postalCode, a.city].filter(Boolean).join(' '),
    [a.region, a.country].filter(Boolean).join(', '),
    a.email ? `✉ ${a.email}` : '',
    a.phone ? `☎ ${a.phone}` : '',
    a.notes ? `📝 ${a.notes}` : '',
  ].filter((line) => line.trim() !== '');
}

/**
 * What the customer sent with the order (only on the device that placed it:
 * it is encrypted for the organiser), and a way to add an email, a phone or
 * notes. Nothing is changed: changes go through the organiser.
 */
export function OrderDetailsSection({
  order,
  shop,
  onAdded,
}: {
  order: Order;
  shop: ShopConfig;
  onAdded: () => void;
}): React.JSX.Element | null {
  const [saved, setSaved] = useState(() => loadOrderDetails(order.id));
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!order.encryptedAddress) return null;
  const canAdd = OPEN.includes(order.status) && Boolean(shop.addressPublicKey && shop.addressKeyFingerprint) && cryptoAvailable();
  // Here we know what is missing; elsewhere every field is offered (filled ones stay as they were).
  const askEmail = !saved?.email?.trim();
  const askPhone = !saved?.phone.trim();
  const emailBad = email.trim() !== '' && !EMAIL_RE.test(email.trim());
  const nothing = email.trim() === '' && phone.trim() === '' && notes.trim() === '';

  const send = async (): Promise<void> => {
    if (!shop.addressPublicKey || !shop.addressKeyFingerprint) return;
    setBusy(true);
    setError(null);
    try {
      const extra: DeliveryExtra = {
        ...(askEmail && email.trim() ? { email: email.trim() } : {}),
        ...(askPhone && phone.trim() ? { phone: phone.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      await api.addOrderDetails(order.id, await encryptAddress(extra, shop.addressPublicKey, shop.addressKeyFingerprint));
      if (saved) {
        const merged = mergeDelivery(saved, [extra]);
        saveOrderDetails(order.id, merged);
        setSaved(merged);
      }
      setEmail('');
      setPhone('');
      setNotes('');
      setAdding(false);
      setDone(true);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('error.title'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section header={t('orderDetails.title')} footer={canAdd ? t('orderDetails.footer') : t('orderDetails.footerSent')}>
      {saved ? (
        <Cell multiline>
          <span className="gb-address-value">{lines(saved).join('\n')}</span>
        </Cell>
      ) : (
        <Cell multiline subtitle={t('orderDetails.otherDeviceHint')}>
          {t('orderDetails.encrypted')}
        </Cell>
      )}
      {order.addressExtras.length > 0 && !saved && (
        <Cell multiline subtitle={t('orderDetails.addedCount', { count: order.addressExtras.length })}>
          {t('orderDetails.addedSent')}
        </Cell>
      )}
      {done && (
        <Cell multiline style={{ color: '#31b545' }}>
          {t('orderDetails.done')}
        </Cell>
      )}
      {canAdd && !adding && (
        <div style={{ padding: 16 }}>
          <Button size="s" mode="bezeled" onClick={() => setAdding(true)}>
            {t('orderDetails.add')}
          </Button>
        </div>
      )}
      {canAdd && adding && (
        <>
          {askEmail && (
            <Input
              header={t('orderDetails.email')}
              type="email"
              autoComplete="email"
              value={email}
              status={emailBad ? 'error' : 'default'}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          {askPhone && (
            <Input
              header={t('orderDetails.phone')}
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          )}
          <Textarea header={t('orderDetails.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
          {error && (
            <Cell multiline style={{ color: 'var(--tgui--destructive_text_color, #e53935)' }}>
              {error}
            </Cell>
          )}
          <div style={{ display: 'flex', gap: 8, padding: 16 }}>
            <Button size="s" disabled={busy || nothing || emailBad} loading={busy} onClick={() => void send()}>
              {t('orderDetails.send')}
            </Button>
            <Button size="s" mode="plain" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}
