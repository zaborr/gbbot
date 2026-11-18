import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import type { DeliveryAddress, Order } from '@tma-shop/shared';
import { copyText } from '../../lib/clipboard.js';
import { decryptOrderDetails, loadPrivateKey, type OrderDetails } from '../../lib/addressCrypto.js';
import { formatDate } from './common.js';
import { useShop } from '../../providers/ShopProvider.js';
import { t, type MessageKey } from '../../i18n/index.js';

type State =
  | { kind: 'loading' }
  | { kind: 'no-key' }
  | { kind: 'other-key' }
  | { kind: 'error' }
  | { kind: 'ok'; details: OrderDetails };

function addressLines(a: DeliveryAddress): string[] {
  return [
    a.name,
    a.line1,
    a.line2,
    [a.postalCode, a.city].filter(Boolean).join(' '),
    [a.region, a.country].filter(Boolean).join(', '),
    a.email ? `✉ ${a.email}` : '',
    a.phone ? `☎ ${a.phone}` : '',
  ].filter((line) => line.trim() !== '');
}

/** The order's delivery address, decrypted here with the private key on this device. */
export function AddressSection({ order }: { order: Order }): React.JSX.Element | null {
  const { shop, to } = useShop();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const envelope = order.encryptedAddress;
    if (!envelope) return;
    const privateKey = loadPrivateKey(shop.id);
    if (!privateKey) {
      setState({ kind: 'no-key' });
      return;
    }
    decryptOrderDetails(order, privateKey)
      .then((details) => {
        if (!cancelled) setState({ kind: 'ok', details });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the extras change with their count
  }, [order.encryptedAddress, order.addressExtras.length, order.addressKeyFingerprint, shop.id, shop.addressKeyFingerprint]);

  if (!order.encryptedAddress) return null;

  const header = order.shippingZoneName
    ? t('addressSection.headerZone', { zone: order.shippingZoneName })
    : t('details.adminTitle');
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
      const { original, extras } = state.details;
      const a = state.details.merged;
      const lines = addressLines(a);
      const all = [...lines, a.notes ? t('addressSection.notes', { notes: a.notes }) : ''].filter(Boolean).join('\n');
      // Each piece on its own (courier forms ask for them one by one), then everything.
      const every: Array<{ key: string; label: MessageKey; value: string }> = [
        { key: 'name', label: 'addressSection.name', value: a.name },
        { key: 'line1', label: 'addressSection.line1', value: a.line1 },
        { key: 'line2', label: 'addressSection.line2', value: a.line2 },
        { key: 'postalCode', label: 'addressSection.postalCode', value: a.postalCode },
        { key: 'city', label: 'addressSection.city', value: a.city },
        { key: 'region', label: 'addressSection.region', value: a.region },
        { key: 'country', label: 'addressSection.country', value: a.country },
        { key: 'phone', label: 'addressSection.phone', value: a.phone },
        { key: 'email', label: 'addressSection.email', value: a.email ?? '' },
        { key: 'notes', label: 'addressSection.notesLabel', value: a.notes },
      ];
      const fields = every.filter((field) => field.value.trim() !== '');
      // What the customer added later: which fields it filled, and what it could not replace.
      const added = new Set<string>();
      const unused: string[] = [];
      for (const { extra } of extras) {
        if (extra.email?.trim()) {
          if (!original.email?.trim()) added.add('email');
          if (a.email?.trim() !== extra.email.trim()) unused.push(`✉ ${extra.email.trim()}`);
        }
        if (extra.phone?.trim()) {
          if (!original.phone.trim()) added.add('phone');
          if (a.phone.trim() !== extra.phone.trim()) unused.push(`☎ ${extra.phone.trim()}`);
        }
        if (extra.notes?.trim()) added.add('notes');
      }
      const lastAdded = extras.length > 0 ? extras[extras.length - 1]?.at : undefined;
      const copy = (key: string, text: string): void => {
        void copyText(text).then((ok) => setCopied(ok ? key : null));
      };
      return (
        <Section header={header}>
          {fields.map((field) => (
            <Cell
              key={field.key}
              multiline
              subtitle={
                added.has(field.key) && lastAdded
                  ? `${t(field.label)} · ${t('addressSection.addedByCustomer', { date: formatDate(lastAdded) })}`
                  : t(field.label)
              }
              after={
                <Button size="s" mode="plain" onClick={() => copy(field.key, field.value.trim())}>
                  {copied === field.key ? '✅' : t('addressSection.copyOne')}
                </Button>
              }
            >
              <span className="gb-address-value">{field.value}</span>
            </Cell>
          ))}
          {unused.length > 0 && (
            <Cell multiline subtitle={t('addressSection.notReplaced')}>
              <span className="gb-address-value">{unused.join('\n')}</span>
            </Cell>
          )}
          <div style={{ padding: 16 }}>
            <Button size="s" mode="bezeled" onClick={() => copy('all', all)}>
              {copied === 'all' ? t('addressSection.copied') : t('addressSection.copy')}
            </Button>
          </div>
        </Section>
      );
    }
  }
}
