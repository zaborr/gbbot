import { Section } from '@telegram-apps/telegram-ui';
import { Input, Textarea } from './Field.js';
import type { DeliveryAddress } from '@tma-shop/shared';
import { t } from '../i18n/index.js';

export const EMPTY_ADDRESS: DeliveryAddress = {
  name: '',
  line1: '',
  line2: '',
  postalCode: '',
  city: '',
  region: '',
  country: '',
  phone: '',
  notes: '',
};

/** Fields every delivery needs. */
export function addressComplete(a: DeliveryAddress): boolean {
  return [a.name, a.line1, a.postalCode, a.city, a.country].every((v) => v.trim() !== '');
}

export function trimAddress(a: DeliveryAddress): DeliveryAddress {
  return {
    name: a.name.trim(),
    line1: a.line1.trim(),
    line2: a.line2.trim(),
    postalCode: a.postalCode.trim(),
    city: a.city.trim(),
    region: a.region.trim(),
    country: a.country.trim(),
    phone: a.phone.trim(),
    notes: a.notes.trim(),
  };
}

/** Delivery address fields (encrypted before leaving the device). */
export function AddressForm({
  value,
  onChange,
}: {
  value: DeliveryAddress;
  onChange: (next: DeliveryAddress) => void;
}): React.JSX.Element {
  const set =
    (field: keyof DeliveryAddress) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
      onChange({ ...value, [field]: e.target.value });

  return (
    <Section
      header={t('address.title')}
      footer={t('address.footer')}
    >
      <Input header={t('address.name')} value={value.name} onChange={set('name')} />
      <Input header={t('address.line1')} placeholder={t('address.line1Placeholder')} value={value.line1} onChange={set('line1')} />
      <Input
        header={t('address.line2')}
        value={value.line2}
        onChange={set('line2')}
      />
      <Input header={t('address.postalCode')} value={value.postalCode} onChange={set('postalCode')} />
      <Input header={t('address.city')} value={value.city} onChange={set('city')} />
      <Input header={t('address.region')} value={value.region} onChange={set('region')} />
      <Input header={t('address.country')} value={value.country} onChange={set('country')} />
      <Input header={t('address.phone')} type="tel" value={value.phone} onChange={set('phone')} />
      <Textarea header={t('address.notes')} value={value.notes} onChange={set('notes')} />
    </Section>
  );
}
