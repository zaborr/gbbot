import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { ENCRYPTED_FIELDS, type CheckoutFields, type FieldMode } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useShop } from '../../providers/ShopProvider.js';
import { asksDetails } from '../../components/AddressForm.js';
import { PageTitle } from '../../components/PageTitle.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { t, type MessageKey } from '../../i18n/index.js';

/** What checkout asks the customer for, and whether it can be left empty. */
export function AdminCheckoutFieldsPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminCheckoutFields />
    </AdminOnly>
  );
}

const MODES: Array<[FieldMode, MessageKey]> = [
  ['off', 'fields.off'],
  ['optional', 'fields.optional'],
  ['required', 'fields.required'],
];

const LABELS: Record<(typeof ENCRYPTED_FIELDS)[number], MessageKey> = {
  name: 'details.name',
  email: 'details.email',
  phone: 'details.phone',
  notes: 'details.notes',
};

function AdminCheckoutFields(): React.JSX.Element {
  const navigate = useNavigate();
  const { shop, reload, to } = useShop();
  const actions = useAdminActions(() => undefined);
  const [fields, setFields] = useState<CheckoutFields>(shop.checkoutFields);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const ships = shop.shippingZones.some((z) => z.isActive);
  const noKey = !shop.addressPublicKey && (ships || asksDetails(fields));

  const set = <K extends keyof CheckoutFields>(field: K, mode: CheckoutFields[K]): void => {
    setFields((prev) => ({ ...prev, [field]: mode }));
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    await actions.run(async () => {
      await api.adminUpdateCheckoutFields(fields);
      setSaved(true);
      reload();
    });
    setBusy(false);
  };

  const picker = <K extends keyof CheckoutFields>(
    field: K,
    modes: Array<[CheckoutFields[K], MessageKey]>,
    locked?: CheckoutFields[K],
  ): React.JSX.Element => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 16px 12px' }}>
      {modes.map(([mode, label]) => (
        <Button
          key={mode}
          size="s"
          mode={(locked ?? fields[field]) === mode ? 'filled' : 'bezeled'}
          disabled={locked !== undefined}
          onClick={() => set(field, mode)}
        >
          {t(label)}
        </Button>
      ))}
    </div>
  );

  return (
    <List>
      <PageTitle title={t('adminHome.checkoutFields')} />
      <ErrorBanner message={actions.error} />
      {noKey && (
        <button type="button" className="gb-banner" onClick={() => navigate(to('/admin/address-key'))}>
          {t('fields.needKey')}
        </button>
      )}

      <Section header={t('cart.usernameField')} footer={t('fields.contactFooter')}>
        {picker('contact', MODES.filter(([m]) => m !== 'off') as Array<['optional' | 'required', MessageKey]>)}
      </Section>

      <Section header={t('fields.encrypted')} footer={t('fields.encryptedFooter')}>
        {ENCRYPTED_FIELDS.map((field) => (
          <div key={field}>
            <Cell multiline subtitle={field === 'name' && ships ? t('fields.nameShipping') : undefined}>
              {t(LABELS[field])}
            </Cell>
            {picker(field, MODES, field === 'name' && ships ? 'required' : undefined)}
          </div>
        ))}
      </Section>

      <Section footer={ships ? t('fields.addressShipping') : t('fields.addressNoShipping')}>
        <Cell multiline>{t('fields.address')}</Cell>
      </Section>

      <Section>
        <div style={{ padding: 16 }}>
          <Button stretched loading={busy} onClick={() => void save()}>
            {saved ? t('common.saved') : t('common.save')}
          </Button>
        </div>
      </Section>
    </List>
  );
}
