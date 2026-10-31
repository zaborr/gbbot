import type { DeliveryAddress, Order } from '@tma-shop/shared';
import { decryptAddress, loadPrivateKey } from './addressCrypto.js';
import { itemName } from './variants.js';
import { lang, t } from '../i18n/index.js';
import { statusLabel } from '../pages/admin/common.js';

/**
 * Orders as a table to paste into Excel or Google Sheets: tab-separated, one
 * row per product (plus the fee and shipping, so the "Subtotal" column adds up
 * to what was charged), numbers with the app language's decimal separator.
 */
export type CellValue = string | number;

/** A cell that never breaks the table: no tabs or line breaks inside. */
function cell(value: CellValue): string {
  if (typeof value === 'number') {
    return value.toLocaleString(lang(), { useGrouping: false, maximumFractionDigits: 2 });
  }
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

export function toTsv(rows: CellValue[][]): string {
  return rows.map((row) => row.map(cell).join('\t')).join('\n');
}

/** Cents of the token as a number Excel understands (12.9 → "12,90" in Spanish). */
function amount(cents: number): CellValue {
  return Number((cents / 100).toFixed(2));
}

/** "2026-10-31 14:02": Excel reads it as a date. */
function dateCell(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function addressCells(a: DeliveryAddress | undefined): CellValue[] {
  if (!a) return ['', '', '', '', '', '', '', '', ''];
  return [a.name, a.line1, a.line2, a.postalCode, a.city, a.region, a.country, a.phone, a.notes];
}

/** The orders' table. Address columns only when `addresses` is given. */
export function orderRows(
  orders: readonly Order[],
  feeLabel: string,
  addresses?: ReadonlyMap<string, DeliveryAddress>,
): CellValue[][] {
  const header: CellValue[] = [
    t('csv.order'),
    t('csv.date'),
    t('sheet.status'),
    t('csv.username'),
    t('sheet.product'),
    t('sheet.quantity'),
    t('sheet.unitPrice'),
    t('sheet.subtotal'),
    t('sheet.currency'),
  ];
  if (addresses) {
    header.push(
      t('csv.zone'),
      t('csv.name'),
      t('csv.address'),
      t('csv.address2'),
      t('csv.postalCode'),
      t('csv.city'),
      t('csv.region'),
      t('csv.country'),
      t('csv.phone'),
      t('csv.notes'),
    );
  }
  const rows: CellValue[][] = [header];
  for (const o of orders) {
    const base: CellValue[] = [
      `#${o.id.slice(0, 8)}`,
      dateCell(o.createdAt),
      statusLabel(o),
      o.contactUsername ? `@${o.contactUsername}` : '',
    ];
    const extra: CellValue[] = addresses
      ? [o.shippingZoneName ?? '', ...addressCells(addresses.get(o.id))]
      : [];
    const line = (name: string, qty: number, unit: number, subtotal: number): void => {
      rows.push([...base, name, qty, amount(unit), amount(subtotal), o.currency, ...extra]);
    };
    for (const item of o.items) line(itemName(item), item.quantity, item.unitPrice, item.subtotal);
    if (o.fee > 0) line(feeLabel, 1, o.fee, o.fee);
    if (o.shippingZoneName) {
      line(t('cart.shippingZoneLine', { zone: o.shippingZoneName }), 1, o.shipping, o.shipping);
    }
  }
  return rows;
}

/**
 * Decrypts the orders' addresses with the key on this device. `missing`
 * counts orders with an address that could not be read here.
 */
export async function decryptAddresses(
  orders: readonly Order[],
  shopId: string,
): Promise<{ addresses: Map<string, DeliveryAddress>; missing: number }> {
  const addresses = new Map<string, DeliveryAddress>();
  const withAddress = orders.filter((o) => o.encryptedAddress);
  const privateKey = loadPrivateKey(shopId);
  if (!privateKey) return { addresses, missing: withAddress.length };
  let missing = 0;
  for (const o of withAddress) {
    try {
      addresses.set(o.id, await decryptAddress(o.encryptedAddress ?? '', privateKey));
    } catch {
      missing += 1;
    }
  }
  return { addresses, missing };
}
