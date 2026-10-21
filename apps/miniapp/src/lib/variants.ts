import { localized, unitPriceFor, type Product, type ProductVariant } from '@tma-shop/shared';
import { lang } from '../i18n/index.js';

/** Active variants (the catalog only sends active ones; admin lists all). */
export function activeVariants(product: Product): ProductVariant[] {
  return product.variants.filter((v) => v.isActive);
}

export function hasVariants(product: Product): boolean {
  return product.options.length > 0;
}

/**
 * The VIP price of one unit for a VIP (the variant's, else the product's), or
 * null when the buyer is not a VIP or there is none. The server only sends VIP
 * prices to VIPs and admins, so `vip` must come from the GB (`shop.isVip`).
 */
export function vipPriceFor(
  product: Product,
  variant: ProductVariant | null,
  vip: boolean,
): number | null {
  if (!vip) return null;
  return variant ? variant.vipPrice : product.vipPrice;
}

/** Whether a VIP pays a VIP price for this product (any of its variants). */
export function hasVipPrice(product: Product, vip: boolean): boolean {
  if (!vip) return false;
  return hasVariants(product)
    ? activeVariants(product).some((v) => v.vipPrice !== null)
    : product.vipPrice !== null;
}

/** Lowest and highest unit price, across variants when the product has them. */
export function priceRange(product: Product, vip = false): { min: number; max: number } {
  const prices = hasVariants(product)
    ? activeVariants(product).map((v) => vipPriceFor(product, v, vip) ?? v.price)
    : [vipPriceFor(product, null, vip) ?? product.price];
  if (prices.length === 0) return { min: product.price, max: product.price };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/** Whether nothing can be bought: no stock left anywhere. */
export function isSoldOut(product: Product): boolean {
  // Less stock than the minimum per order: it cannot be bought either.
  const min = Math.max(1, product.minQuantity);
  if (!hasVariants(product)) return product.stock !== null && product.stock < min;
  const variants = activeVariants(product);
  if (variants.length === 0) return true;
  if (variants.some((v) => v.stock === null)) return false;
  return variants.reduce((sum, v) => sum + Math.max(v.stock ?? 0, 0), 0) < min;
}

/** The variant matching one chosen value per option, if every option is chosen. */
export function findVariant(
  product: Product,
  selected: ReadonlyArray<string | null>,
): ProductVariant | null {
  if (selected.some((value) => value === null)) return null;
  return (
    activeVariants(product).find((v) => v.values.every((value, i) => value === selected[i])) ??
    null
  );
}

/**
 * Whether choosing `value` for option `index` still leads to a sellable
 * variant, given the other choices made so far.
 */
export function isValueAvailable(
  product: Product,
  selected: ReadonlyArray<string | null>,
  index: number,
  value: string,
): boolean {
  return activeVariants(product).some(
    (v) =>
      v.values[index] === value &&
      (v.stock === null || v.stock > 0) &&
      v.values.every((other, i) => i === index || selected[i] === null || selected[i] === other),
  );
}

/** "T-shirt (Red / M)" */
export function lineName(title: string, variantLabel: string | null | undefined): string {
  return variantLabel ? `${title} (${variantLabel})` : title;
}

/** Identity of an order line: product plus variant. */
export function itemKey(item: { productId: string; variantId?: string | null }): string {
  return `${item.productId}:${item.variantId ?? ''}`;
}

/** An order line as the customer sees it: in their language, with its variant. */
export function customerItemName(item: {
  title: string;
  titleEn?: string | null | undefined;
  variantLabel?: string | null | undefined;
}): string {
  return lineName(localized(lang(), item.title, item.titleEn), item.variantLabel);
}

/** Display name of an order line, with its variant (admins: the Spanish title). */
export function itemName(item: { title: string; variantLabel?: string | null }): string {
  return lineName(item.title, item.variantLabel);
}

/**
 * Price table for one unit of a product (or variant): `[{ from, to, price }]`,
 * `to` = null for the last, open-ended tier. Empty when there are no tiers.
 */
export function tierTable(
  product: Product,
  variant: ProductVariant | null,
  vip = false,
): Array<{ from: number; to: number | null; price: number }> {
  // A VIP price is fixed: no tiers.
  if (product.priceTiers.length === 0 || vipPriceFor(product, variant, vip) !== null) return [];
  // Nobody can buy fewer than the minimum: the table starts there, and tiers
  // that end below it are left out.
  const min = Math.max(1, product.minQuantity);
  const starts = [1, ...product.priceTiers.map((t) => t.minQty)];
  return starts
    .map((from, i) => ({
      from: Math.max(from, min),
      to: i + 1 < starts.length ? (starts[i + 1] ?? from) - 1 : null,
    }))
    .filter((row) => row.to === null || row.to >= row.from)
    .map((row) => ({
      ...row,
      price: unitPriceFor(product.price, variant?.priceOverride ?? null, product.priceTiers, row.from),
    }));
}
