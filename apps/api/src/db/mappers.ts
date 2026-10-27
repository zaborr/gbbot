import type {
  Category,
  GoalProgress,
  OrganizerTag,
  Order,
  OrderItem,
  Product,
  ProductVariant,
  SessionUser,
  ShopAdminView,
  ShopConfig,
  ShopSummary,
} from '@tma-shop/shared';
import type {
  categories,
  orderItems,
  orders,
  productVariants,
  products,
  shops,
  users,
} from './schema.js';
import {
  EMPTY_PAYMENT_SETUP,
  MANUAL_METHOD_PREFIX,
  isClosedAt,
  isLang,
  manualMethodsOf,
  NO_EXCHANGE,
  paymentMethodsOf,
  userLang,
} from '@tma-shop/shared';
import { explorerTxUrl } from '../config/payment-methods.js';

type ProductRow = typeof products.$inferSelect;
type CategoryRow = typeof categories.$inferSelect;
type ShopRow = typeof shops.$inferSelect;
type UserRow = typeof users.$inferSelect;
type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

type VariantRow = typeof productVariants.$inferSelect;

/** "Red / M" */
export function variantLabel(values: readonly string[]): string {
  return values.join(' / ');
}

/**
 * `showVip`: VIP prices are only sent to the GB's VIPs and its admins; for
 * everyone else they are null.
 */
export function toVariantDTO(row: VariantRow, product: ProductRow, showVip = false): ProductVariant {
  return {
    id: row.id,
    values: row.optionValues,
    label: variantLabel(row.optionValues),
    priceOverride: row.price,
    price: row.price ?? product.price,
    vipPriceOverride: showVip ? row.vipPrice : null,
    vipPrice: showVip ? (row.vipPrice ?? product.vipPrice) : null,
    stock: row.stock,
    isActive: row.isActive,
  };
}

/** `variants` should already be filtered (active only for customers) and sorted. */
export function toProductDTO(
  row: ProductRow,
  variants: readonly VariantRow[] = [],
  showVip = false,
): Product {
  return {
    id: row.id,
    shopId: row.shopId,
    categoryId: row.categoryId,
    slug: row.slug,
    title: row.title,
    description: row.description,
    titleEn: row.titleEn,
    descriptionEn: row.descriptionEn,
    price: row.price,
    vipPrice: showVip ? row.vipPrice : null,
    currency: row.currency,
    imageUrl: row.imageUrl,
    stock: row.stock,
    isActive: row.isActive,
    vipOnly: row.vipOnly,
    minQuantity: row.minQuantity,
    options: row.options,
    priceTiers: row.priceTiers,
    variants: row.options.length > 0 ? variants.map((v) => toVariantDTO(v, row, showVip)) : [],
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCategoryDTO(row: CategoryRow): Category {
  return {
    id: row.id,
    shopId: row.shopId,
    slug: row.slug,
    title: row.title,
    sortOrder: row.sortOrder,
  };
}

export function toShopConfigDTO(
  row: ShopRow,
  canManage = false,
  isVip = false,
  extra: {
    canOwn?: boolean;
    organizers?: OrganizerTag[];
    disclaimerAccepted?: boolean;
    goal?: GoalProgress | null;
  } = {},
): ShopConfig {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    nameEn: row.nameEn,
    descriptionEn: row.descriptionEn,
    imageUrl: row.imageUrl,
    isVisible: row.isVisible,
    vipOnly: row.vipOnly,
    closedAt: row.closedAt?.toISOString() ?? null,
    closesAt: row.closesAt?.toISOString() ?? null,
    closingWarnHours: row.closingWarnHours,
    currency: row.currency,
    orderFee: row.orderFee,
    orderFeeLabel: row.orderFeeLabel,
    vipNoFee: row.vipNoFee,
    vipNoShipping: row.vipNoShipping,
    autoCancelHours: row.autoCancelHours,
    overpayMargin: row.overpayMargin,
    shippingZones: row.shippingZones,
    addressPublicKey: row.addressPublicKey,
    addressKeyFingerprint: row.addressKeyFingerprint,
    paymentMethods: paymentMethodsOf(row.paymentSetup),
    manualMethods: manualMethodsOf(row.paymentSetup),
    exchangeRates: row.paymentSetup?.exchange ?? NO_EXCHANGE,
    canManage,
    isVip,
    isClosed: isClosedAt(row),
    canOwn: extra.canOwn ?? false,
    organizers: extra.organizers ?? [],
    goal: extra.goal ?? null,
    disclaimer:
      row.disclaimer && row.disclaimerVersion > 0
        ? { text: row.disclaimer, version: row.disclaimerVersion }
        : null,
    disclaimerAccepted: extra.disclaimerAccepted ?? true,
  };
}

export function toShopSummaryDTO(
  row: ShopRow,
  canManage: boolean,
  isVip = false,
  activity: { cartItems: number; unpaidOrders: number } = { cartItems: 0, unpaidOrders: 0 },
  organizers: OrganizerTag[] = [],
  goal: GoalProgress | null = null,
): ShopSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    nameEn: row.nameEn,
    descriptionEn: row.descriptionEn,
    imageUrl: row.imageUrl,
    isVisible: row.isVisible,
    vipOnly: row.vipOnly,
    closesAt: row.closesAt?.toISOString() ?? null,
    canManage,
    isVip,
    isClosed: isClosedAt(row),
    cartItems: activity.cartItems,
    unpaidOrders: activity.unpaidOrders,
    organizers,
    goal,
  };
}

export function toShopAdminDTO(row: ShopRow): ShopAdminView {
  return {
    ...toShopConfigDTO(row, true),
    sortOrder: row.sortOrder,
    adminIds: row.adminIds,
    adminUsernames: row.adminUsernames,
    ownerIds: row.ownerIds,
    ownerUsernames: row.ownerUsernames,
    goalAmount: row.goalAmount,
    goalShowAmount: row.goalShowAmount,
    paymentSetup: row.paymentSetup ?? EMPTY_PAYMENT_SETUP,
  };
}

export function toSessionUserDTO(row: UserRow, role: SessionUser['role']): SessionUser {
  return {
    telegramId: row.telegramId,
    firstName: row.firstName,
    username: row.username,
    languageCode: row.languageCode,
    role,
    language: userLang(row.preferredLang, row.languageCode),
    preferredLanguage: isLang(row.preferredLang) ? row.preferredLang : null,
  };
}

export function toOrderItemDTO(row: OrderItemRow): OrderItem {
  return {
    productId: row.productId,
    variantId: row.variantId,
    variantLabel: row.variantLabel,
    title: row.title,
    titleEn: row.titleEn,
    unitPrice: row.unitPrice,
    quantity: row.quantity,
    subtotal: row.subtotal,
  };
}

export function toOrderDTO(row: OrderRow, items: OrderItemRow[]): Order {
  return {
    id: row.id,
    shopId: row.shopId,
    userId: row.userId,
    status: row.status,
    items: items.map(toOrderItemDTO),
    isVip: row.isVip,
    total: row.total,
    fee: row.fee,
    shipping: row.shipping,
    shippingZoneName: row.shippingZoneName,
    encryptedAddress: row.encryptedAddress,
    addressKeyFingerprint: row.addressKeyFingerprint,
    currency: row.currency,
    paymentNetwork: row.paymentNetwork,
    paymentTxHash: row.paymentTxHash,
    paymentTxUrl: explorerTxUrl(row.paymentNetwork, row.paymentTxHash),
    paymentCheck: row.paymentCheck ?? null,
    paymentExchange: row.paymentExchange ?? null,
    paymentManual: row.paymentMethodId?.startsWith(MANUAL_METHOD_PREFIX) ?? false,
    contactUsername: row.contactUsername,
    trackingNumber: row.trackingNumber,
    statusNote: row.statusNote,
    amountPaid: row.amountPaid,
    // A cancelled order owes nothing; whatever was paid goes back.
    amountDue: (row.status === 'cancelled' ? 0 : row.total) - row.amountPaid,
    amountSubmitted: row.amountSubmitted,
    // Requests saved before variants existed lack the variant fields.
    changeRequest: row.changeRequest
      ? {
          ...row.changeRequest,
          items: row.changeRequest.items.map((item) => ({
            ...item,
            variantId: item.variantId ?? null,
            variantLabel: item.variantLabel ?? null,
          })),
        }
      : null,
    paymentLog: row.paymentLog,
    closedAt: row.closedAt?.toISOString() ?? null,
    anonymizedAt: row.anonymizedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
