import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import type { DeliveryAddress, Order } from '@tma-shop/shared';
import { copyText } from '../../lib/clipboard.js';
import { decryptAddress, loadPrivateKey } from '../../lib/addressCrypto.js';
import { useShop } from '../../providers/ShopProvider.js';
import { t } from '../../i18n/index.js';

type State =
  | { kind: 'loading' }
  | { kind: 'no-key' }
  | { kind: 'other-key' }
  | { kind: 'error' }
  | { kind: 'ok'; address: DeliveryAddress };

function addressLines(a: DeliveryAddress): string[] {
  return [
    a.name,
    a.line1,
    a.line2,
    [a.postalCode, a.city].filter(Boolean).join(' '),
    [a.region, a.country].filter(Boolean).join(', '),
    a.phone ? `☎ ${a.phone}` : '',
  ].filter((line) => line.trim() !== '');
}

/** The order's delivery address, decrypted here with the private key on this device. */
export function AddressSection({ order }: { order: Order }): React.JSX.Element | null {
  const { shop, to } = useShop();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const envelope = order.encryptedAddress;
    if (!envelope) return;
    const privateKey = loadPrivateKey(shop.id);
    if (!privateKey) {
      setState({ kind: 'no-key' });
      return;
    }
    decryptAddress(envelope, privateKey)
      .then((address) => {
        if (!cancelled) setState({ kind: 'ok', address });
      })
      .catch(() => {
        if (cancelled) return;
        // Most often: the address was encrypted with a key that was replaced since.
        const olderKey =
          order.addressKeyFingerprint !== null &&
          order.addressKeyFingerprint !== shop.addressKeyFingerprint;
        setState({ kind: olderKey ? 'other-key' : 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [order.encryptedAddress, order.addressKeyFingerprint, shop.id, shop.addressKeyFingerprint]);

  if (!order.encryptedAddress) return null;

  const header = order.shippingZoneName
    ? t('addressSection.headerZone', { zone: order.shippingZoneName })
    : t('address.title');
  const keyButton = (
    <div style={{ padding: '0 16px 16px' }}>
      <Button size="s" mode="bezeled" onClick={() => navigate(to('/admin/address-key'))}>
        {t('adminHome.addressKey')}
      </Button>
    </div>
  );

  switch (state.kind) {
    case 'loading':
      return (
        <Section header={header}>
          <Cell>{t('addressSection.decrypting')}</Cell>
        </Section>
      );
    case 'no-key':
      return (
        <Section header={header}>
          <Cell multiline>
            {t('addressSection.noKey')}
          </Cell>
          {keyButton}
        </Section>
      );
    case 'other-key':
      return (
        <Section header={header}>
          <Cell multiline>
            {t('addressSection.olderKey', { id: order.addressKeyFingerprint ?? '?' })}
          </Cell>
          {keyButton}
        </Section>
      );
    case 'error':
      return (
        <Section header={header}>
          <Cell multiline>
            {t('addressSection.wrongKey')}
          </Cell>
          {keyButton}
        </Section>
      );
    case 'ok': {
      const lines = addressLines(state.address);
      return (
        <Section header={header} footer={state.address.notes ? t('addressSection.notes', { notes: state.address.notes }) : undefined}>
          {lines.map((line, i) => (
            <Cell key={i} multiline>
              {line}
            </Cell>
          ))}
          <div style={{ padding: 16 }}>
            <Button
              size="s"
              mode="bezeled"
              onClick={() =>
                void copyText(
                  [...lines, state.address.notes ? t('addressSection.notes', { notes: state.address.notes }) : '']
                    .filter(Boolean)
                    .join('\n'),
                ).then(setCopied)
              }
            >
              {copied ? t('addressSection.copied') : t('addressSection.copy')}
            </Button>
          </div>
        </Section>
      );
    }
  }
}
