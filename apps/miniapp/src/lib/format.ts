import { fiatCurrencyOf } from '@tma-shop/shared';
import { lang } from '../i18n/index.js';

/** Formats a money amount stored in cents of the token: "12.90 USDC". */
export function formatPrice(amount: number, currency: string): string {
  const major = (amount / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${major} ${currency}`;
}

export function pluralize(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Amount the customer must send in the order's token (USDC, EURC…), from a
 * total stored in cents of that token. Shown without thousands separators so it
 * can be typed or pasted straight into a wallet.
 */
export function formatTokenAmount(amount: number, token: string): string {
  return `${(amount / 100).toFixed(2)} ${token}`;
}

/**
 * The amount as money, for manual methods (Wise, Bizum…): EURC as euros and
 * USDC as dollars, one to one ("25,00 €", "$25.00").
 */
export function formatFiat(amount: number, token: string): string {
  const currency = fiatCurrencyOf(token);
  if (!currency) return formatTokenAmount(amount, token);
  try {
    return new Intl.NumberFormat(lang(), { style: 'currency', currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}
