import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import type { DeliveryAddress, Order, ShopConfig } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { AddressForm, addressComplete, EMPTY_ADDRESS } from './AddressForm.js';
import { cryptoAvailable, encryptAddress, loadSavedAddress, saveOrderDetails } from '../lib/addressCrypto.js';
import { t } from '../i18n/index.js';

const OPEN: ReadonlyArray<Order['status']> = ['pending', 'awaiting_payment', 'paid'];

/** An order made by the organisers with a shipping zone and no address yet: the customer adds it. */
export function OrderAddressSection({
  order,
  shop,
  onSaved,
}: {
  order: Order;
  shop: ShopConfig;
  onSaved: () => void;
}): React.JSX.Element | null {
  const [address, setAddress] = useState<DeliveryAddress>(() => ({ ...EMPTY_ADDRESS, ...(loadSavedAddress() ?? {}) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!order.shippingZoneName || order.encryptedAddress || !OPEN.includes(order.status)) return null;
  const ready = Boolean(shop.addressPublicKey && shop.addressKeyFingerprint) && cryptoAvailable();
  const complete = addressComplete(address) && address.name.trim() !== '';

  const save = async (): Promise<void> => {
    if (!shop.addressPublicKey || !shop.addressKeyFingerprint) return;
    setBusy(true);
    setError(null);
    try {
      await api.setOrderAddress(order.id, await encryptAddress(address, shop.addressPublicKey, shop.addressKeyFingerprint));
      saveOrderDetails(order.id, address);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('error.title'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section header={t('orderAddress.title')}>
        <Cell multiline>{t('orderAddress.intro')}</Cell>
      </Section>
      <AddressForm value={address} onChange={setAddress} />
      <Section footer={error ?? (ready ? t('orderAddress.footer') : t('cart.noDeliveryYet'))}>
        <div style={{ padding: 16 }}>
          <Button stretched loading={busy} disabled={!ready || !complete} onClick={() => void save()}>
            {t('orderAddress.save')}
          </Button>
        </div>
      </Section>
    </>
  );
}
