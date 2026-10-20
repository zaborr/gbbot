import { describe, expect, it } from 'vitest';
import {
  RATE_SCALE,
  catalogQuery,
  convertAmount,
  convertBack,
  exchangeRateFor,
  currencyCode,
  priceTiers,
  product,
  shippingCost,
  slug,
  unitPriceFor,
} from './index.js';

describe('common schemas', () => {
  it('accepts kebab-case slugs and rejects others', () => {
    expect(slug.parse('hookah-bowl-2')).toBe('hookah-bowl-2');
    expect(slug.safeParse('Not Valid').success).toBe(false);
    expect(slug.safeParse('trailing-').success).toBe(false);
  });

  it('accepts uppercase currency codes', () => {
    expect(currencyCode.parse('USDC')).toBe('USDC');
    expect(currencyCode.parse('EURC')).toBe('EURC');
    expect(currencyCode.safeParse('usd').success).toBe(false);
  });
});

describe('catalogQuery', () => {
  it('applies pagination defaults and coerces query strings', () => {
    const parsed = catalogQuery.parse({ search: 'tea' });
    expect(parsed).toMatchObject({ page: 1, limit: 20, search: 'tea' });
  });

  it('coerces numeric strings from the query string', () => {
    const parsed = catalogQuery.parse({ page: '3', limit: '50' });
    expect(parsed.page).toBe(3);
    expect(parsed.limit).toBe(50);
  });

  it('rejects an over-large page size', () => {
    expect(catalogQuery.safeParse({ limit: '1000' }).success).toBe(false);
  });
});

describe('product', () => {
  it('rejects a negative price', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000000',
      shopId: '00000000-0000-4000-8000-000000000001',
      categoryId: null,
      slug: 'demo',
      title: 'Demo',
      description: '',
      price: -1,
      currency: 'USDC',
      imageUrl: null,
      stock: null,
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(product.safeParse(base).success).toBe(false);
  });
});

describe('quantity tiers', () => {
  const tiers = [
    { minQty: 5, price: 900 },
    { minQty: 15, price: 800 },
  ];

  it('uses the product price below the first tier', () => {
    expect(unitPriceFor(1000, null, tiers, 4)).toBe(1000);
  });

  it('uses the highest tier reached', () => {
    expect(unitPriceFor(1000, null, tiers, 5)).toBe(900);
    expect(unitPriceFor(1000, null, tiers, 14)).toBe(900);
    expect(unitPriceFor(1000, null, tiers, 30)).toBe(800);
  });

  it('keeps a variant’s price difference', () => {
    expect(unitPriceFor(1000, 1200, tiers, 15)).toBe(1000);
  });

  it('sorts tiers and rejects repeated quantities', () => {
    expect(priceTiers.parse([{ minQty: 15, price: 8 }, { minQty: 5, price: 9 }])[0]?.minQty).toBe(5);
    expect(priceTiers.safeParse([{ minQty: 5, price: 9 }, { minQty: 5, price: 8 }]).success).toBe(
      false,
    );
  });
});

describe('exchange rates', () => {
  const rates = { EURC: 11_000, USDC: null };
  it('converts only where the shop set a rate, rounding in its favour', () => {
    expect(exchangeRateFor(rates, 'EURC', 'EURC')).toBe(RATE_SCALE);
    expect(exchangeRateFor(rates, 'EURC', 'USDC')).toBe(11_000);
    expect(exchangeRateFor(rates, 'USDC', 'EURC')).toBeNull();
    expect(convertAmount(3000, 11_000)).toBe(3300);
    expect(convertAmount(1001, 10_835)).toBe(1085);
    expect(convertBack(1085, 10_835)).toBe(1001);
  });
});

describe('shippingCost', () => {
  const zone = { price: 600, freeFrom: 5000 };
  it('is free from the threshold, and always for VIPs when the GB says so', () => {
    expect(shippingCost(zone, 4999)).toBe(600);
    expect(shippingCost(zone, 5000)).toBe(0);
    expect(shippingCost(zone, 100, true)).toBe(0);
  });
});
