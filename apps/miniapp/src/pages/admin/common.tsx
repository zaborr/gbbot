import { useState } from 'react';
import { Cell, Section } from '@telegram-apps/telegram-ui';
import { isSaleStatus, type Order, type OrderStatus, type Product, type ProductInput } from '@tma-shop/shared';
import { ApiClientError } from '../../api/client.js';
import { useShop } from '../../providers/ShopProvider.js';
import { ErrorView } from '../../components/ErrorView.js';
import { itemName } from '../../lib/variants.js';
import { locale, t, type MessageKey } from '../../i18n/index.js';

/** Tokens a product can be priced in. Prices are stored in cents (1290 = 12.90). */
export const TOKENS = ['USDC', 'EURC'] as const;
export type Token = (typeof TOKENS)[number];

/** Order status as the admin sees it. */
export function adminStatusText(status: OrderStatus): string {
  const keys: Record<OrderStatus, MessageKey> = {
    pending: 'adminStatus.pending',
    awaiting_payment: 'adminStatus.awaiting_payment',
    paid: 'adminStatus.paid',
    cancelled: 'adminStatus.cancelled',
    shipped: 'adminStatus.shipped',
    fulfilled: 'adminStatus.fulfilled',
  };
  return t(keys[status]);
}

/** Status shown to the admin, including change requests and pending refunds. */
export function statusLabel(order: Order): string {
  if (order.changeRequest) return t('adminStatus.changeRequested');
  if (order.status === 'pending' && order.amountPaid > 0) return t('adminStatus.differenceUnpaid');
  if (order.amountDue < 0) return t('adminStatus.refundOwed');
  return adminStatusText(order.status);
}

/** Orders counted as sales: payment confirmed (shipped and delivered included). */
export function isSale(order: Order): boolean {
  return isSaleStatus(order.status);
}

/** Orders that need the admin to do something. */
export function needsAttention(order: Order): boolean {
  return (
    order.status === 'awaiting_payment' ||
    order.changeRequest !== null ||
    order.amountDue < 0
  );
}

/** Major units ("12.90") from a price stored in cents. */
export function toMajor(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function toInput(product: Product, isActive: boolean): ProductInput {
  return {
    categoryId: product.categoryId,
    slug: product.slug,
    title: product.title,
    description: product.description,
    titleEn: product.titleEn,
    descriptionEn: product.descriptionEn,
    price: product.price,
    // Admins get the VIP prices; keep them when only the status changes.
    vipPrice: product.vipPrice,
    currency: product.currency,
    imageUrl: product.imageUrl,
    stock: product.stock,
    isActive,
    vipOnly: product.vipOnly,
    minQuantity: product.minQuantity,
    options: product.options,
    priceTiers: product.priceTiers,
    variants: product.variants.map((v) => ({
      values: v.values,
      price: v.priceOverride,
      vipPrice: v.vipPriceOverride,
      stock: v.stock,
      isActive: v.isActive,
    })),
  };
}

/** One line per order: "2× Sencha, 1× Gaiwan". */
export function itemsSummary(order: Order): string {
  return order.items.map((item) => `${item.quantity}× ${itemName(item)}`).join(', ');
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale(), {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export interface AdminActions {
  /** Runs an API action, shows its error if any, then calls `onDone`. */
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** Same as `run`, but only on the second tap of the button `key`. */
  twoTap: (key: string, action: () => Promise<unknown>) => Promise<void>;
  /** Button text, swapped for the confirmation prompt once armed. */
  tapLabel: (key: string, text: string, confirmText?: string) => string;
  error: string | null;
  /** API error code of the last failed action, e.g. `stock_short`. */
  errorCode: string | null;
}

/**
 * Shared admin action helpers. Destructive actions use a two-tap confirmation
 * because native confirm dialogs are unreliable in Telegram webviews.
 */
export function useAdminActions(onDone: () => void): AdminActions {
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setErrorCode(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('error.title'));
      setErrorCode(err instanceof ApiClientError ? err.code : null);
    }
  };

  const twoTap = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    if (armed !== key) {
      setArmed(key);
      return;
    }
    setArmed(null);
    await run(action);
  };

  const tapLabel = (key: string, text: string, confirmText?: string): string =>
    armed === key ? (confirmText ?? t('common.tapAgainToConfirm')) : text;

  return { run, twoTap, tapLabel, error, errorCode };
}

export function ErrorBanner({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null;
  return (
    <Section>
      <Cell multiline style={{ color: 'var(--tgui--destructive_text_color)' }}>
        {message}
      </Cell>
    </Section>
  );
}

/** Renders its children only for this shop's admins (and platform super-admins). */
export function AdminOnly({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { canManage } = useShop();
  if (!canManage) return <ErrorView message={t('admin.only')} />;
  return <>{children}</>;
}
