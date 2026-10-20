import { convertAmount, exchangeRateFor, type ShopConfig } from '@tma-shop/shared';
import { formatPrice } from './format.js';

/**
 * The other token a price in `currency` can be paid with: only when the GB set
 * a rate for it and accepts that token on some network.
 */
export function otherPayment(
  shop: Pick<ShopConfig, 'paymentMethods' | 'exchangeRates'>,
  currency: string,
): { token: string; rate: number } | null {
  const token = currency === 'EURC' ? 'USDC' : currency === 'USDC' ? 'EURC' : null;
  if (!token || !shop.paymentMethods.some((m) => m.token === token)) return null;
  const rate = exchangeRateFor(shop.exchangeRates, currency, token);
  return rate === null ? null : { token, rate };
}

/** An amount in the other token, rounded up like the payment ("33.00 USDC"). */
export function convertedPrice(amount: number, other: { token: string; rate: number }): string {
  return formatPrice(convertAmount(amount, other.rate), other.token);
}
