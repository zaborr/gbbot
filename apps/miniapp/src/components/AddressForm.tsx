import { Section } from '@telegram-apps/telegram-ui';
import { Input, Textarea } from './Field.js';
import {
  ENCRYPTED_FIELDS,
  type CheckoutFields,
  type DeliveryAddress,
  type FieldMode,
} from '@tma-shop/shared';
import { t, type MessageKey } from '../i18n/index.js';

export const EMPTY_ADDRESS: DeliveryAddress = {
  name: '',
  email: '',
  line1: '',
  line2: '',
  postalCode: '',
  city: '',
  region: '',
  country: '',
  phone: '',
  notes: '',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Postal fields every delivery needs. */
export function addressComplete(a: DeliveryAddress): boolean {
  return [a.line1, a.postalCode, a.city, a.country].every((v) => v.trim() !== '');
}

/**
 * The GB's fields as checkout applies them: a delivery always needs a
 * recipient, so with shipping the name is required.
 */
export function effectiveFields(fields: CheckoutFields, shipping: boolean): CheckoutFields {
  return shipping ? { ...fields, name: 'required' } : fields;
}

/** Whether checkout asks for anything that goes in the encrypted block. */
export function asksDetails(fields: CheckoutFields): boolean {
  return ENCRYPTED_FIELDS.some((field) => fields[field] !== 'off');
}

/** What is wrong with the customer's details, or null when they are fine. */
export function detailsProblem(a: DeliveryAddress, fields: CheckoutFields): MessageKey | null {
  for (const field of ENCRYPTED_FIELDS) {
    if (fields[field] === 'required' && (a[field] ?? '').trim() === '') return 'cart.needDetails';
  }
  const email = (a.email ?? '').trim();
  if (fields.email !== 'off' && email !== '' && !EMAIL_RE.test(email)) return 'cart.badEmail';
  return null;
}

/** Trimmed, and without what the GB does not ask for (nothing extra is encrypted). */
export function cleanDetails(a: DeliveryAddress, fields: CheckoutFields, shipping: boolean): DeliveryAddress {
  const keep = (field: (typeof ENCRYPTED_FIELDS)[number]): string =>
    fields[field] === 'off' ? '' : (a[field] ?? '').trim();
  const postal = (value: string): string => (shipping ? value.trim() : '');
  return {
    name: keep('name'),
    email: keep('email'),
    line1: postal(a.line1),
    line2: postal(a.line2),
    postalCode: postal(a.postalCode),
    city: postal(a.city),
    region: postal(a.region),
    country: postal(a.country),
    phone: keep('phone'),
    notes: keep('notes'),
  };
}

const LABELS = {
  name: 'details.name',
  email: 'details.email',
  phone: 'details.phone',
  notes: 'details.notes',
} as const satisfies Record<(typeof ENCRYPTED_FIELDS)[number], MessageKey>;

function label(key: MessageKey, mode: FieldMode): string {
  return mode === 'required' ? `${t(key)} *` : `${t(key)} (${t('details.optional')})`;
}

/** Postal address fields (encrypted before leaving the device). */
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
    <Section header={t('address.title')} footer={t('address.footer')}>
      <Input header={t('address.line1')} placeholder={t('address.line1Placeholder')} value={value.line1} onChange={set('line1')} />
      <Input header={t('address.line2')} value={value.line2} onChange={set('line2')} />
      <Input header={t('address.postalCode')} value={value.postalCode} onChange={set('postalCode')} />
      <Input header={t('address.city')} value={value.city} onChange={set('city')} />
      <Input header={t('address.region')} value={value.region} onChange={set('region')} />
      <Input header={t('address.country')} value={value.country} onChange={set('country')} />
    </Section>
  );
}

/** The other details the GB asks for (also encrypted), in the order they are shown. */
export function DetailsFields({
  value,
  onChange,
  fields,
}: {
  value: DeliveryAddress;
  onChange: (next: DeliveryAddress) => void;
  fields: CheckoutFields;
}): React.JSX.Element {
  const set =
    (field: keyof DeliveryAddress) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
      onChange({ ...value, [field]: e.target.value });
  return (
    <>
      {fields.name !== 'off' && (
        <Input header={label(LABELS.name, fields.name)} value={value.name} onChange={set('name')} />
      )}
      {fields.email !== 'off' && (
        <Input
          header={label(LABELS.email, fields.email)}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={value.email ?? ''}
          onChange={set('email')}
        />
      )}
      {fields.phone !== 'off' && (
        <Input header={label(LABELS.phone, fields.phone)} type="tel" value={value.phone} onChange={set('phone')} />
      )}
      {fields.notes !== 'off' && (
        <Textarea header={label(LABELS.notes, fields.notes)} value={value.notes} onChange={set('notes')} />
      )}
    </>
  );
}
