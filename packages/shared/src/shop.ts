import { z } from 'zod';
import { currencyCode, id, isoDateTime, slug } from './common.js';
import { person, personRef, telegramUserId } from './user.js';
import { addressFor, exchangeRates, manualMethodView, paymentMethod, paymentSetup } from './payments.js';

/**
 * A shop (store). One deployment hosts several shops; each has its own catalog,
 * carts, orders, wallets, fee and admins. Platform super-admins (configured on
 * the API) create shops, hide them and assign their admins.
 */
/** A shipping zone: a flat cost per order, optionally free from an order amount. */
export const shippingZone = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(64),
  /** Cost per order, in minor units of the order's token. */
  price: z.number().int().nonnegative(),
  /** Free shipping when the items reach this amount; null = never free. */
  freeFrom: z.number().int().positive().nullable(),
  isActive: z.boolean(),
});
export type ShippingZone = z.infer<typeof shippingZone>;

/** How checkout treats one piece of the customer's data. */
export const fieldMode = z.enum(['off', 'optional', 'required']);
export type FieldMode = z.infer<typeof fieldMode>;

/**
 * What checkout asks for. The Telegram @ is kept on the order as it is; the
 * rest goes in the block encrypted on the customer's device (with the postal
 * address, asked whenever the GB ships), so it needs the GB's address key.
 */
export const checkoutFields = z.object({
  contact: z.enum(['optional', 'required']),
  name: fieldMode,
  email: fieldMode,
  phone: fieldMode,
  notes: fieldMode,
});
export type CheckoutFields = z.infer<typeof checkoutFields>;

/** Only the Telegram @ (a GB that ships always asks for the name too). */
export const DEFAULT_CHECKOUT_FIELDS: CheckoutFields = {
  contact: 'required',
  name: 'off',
  email: 'off',
  phone: 'off',
  notes: 'off',
};

/** The fields kept in the encrypted block (all but the Telegram @). */
export const ENCRYPTED_FIELDS = ['name', 'email', 'phone', 'notes'] as const;

export const shop = z.object({
  id,
  /** URL-friendly unique name, e.g. `tea-shop`. */
  slug,
  /** Spanish (the main text). */
  name: z.string().min(1).max(128),
  description: z.string().max(1024),
  /** English version for apps not in Spanish; null = show the Spanish one. */
  nameEn: z.string().max(128).nullable(),
  descriptionEn: z.string().max(1024).nullable(),
  /** Logo or cover shown in the shop list. */
  imageUrl: z.url().nullable(),
  /** Hidden shops are only visible to their admins and platform super-admins. */
  isVisible: z.boolean(),
  /** Visible only to VIP club members (and admins). Only matters while visible. */
  vipOnly: z.boolean(),
  /** With `vipOnly`: its guests see it too, at normal prices. */
  allowGuests: z.boolean(),
  /** Customers see "Organised by" with the team's names (the team always does). */
  showOrganizers: z.boolean(),
  /** When the GB was closed (no new orders), or null while open. */
  closedAt: isoDateTime.nullable(),
  /** Scheduled closing, or null. */
  closesAt: isoDateTime.nullable(),
  /** Hours before the scheduled closing when customers get the big notice. */
  closingWarnHours: z.number().int().min(0).max(720),
  /** Position in the shop list (ascending). */
  sortOrder: z.number().int(),
  currency: currencyCode,
  /** Fixed fee added once to every order, in minor units of the order's token. 0 = none. */
  orderFee: z.number().int().nonnegative(),
  /** How the fee is shown to customers, e.g. "Service fee". */
  orderFeeLabel: z.string().min(1).max(64),
  /** The GB's VIPs do not pay the per-order fee. */
  vipNoFee: z.boolean(),
  /** The GB's VIPs do not pay shipping. */
  vipNoShipping: z.boolean(),
  /** Unpaid orders are cancelled after this many hours without activity (0 = never). */
  autoCancelHours: z.number().int().min(0).max(720),
  /**
   * Paying up to this much too much (minor units) counts as paying exactly the
   * price: no refund noted. Paying too little still goes to review. 0 = off.
   */
  overpayMargin: z.number().int().nonnegative(),
  /** Shipping zones; with active ones, checkout asks for a zone and an address. */
  shippingZones: z.array(shippingZone),
  /** What checkout asks for. */
  checkoutFields,
  /**
   * Public key (RSA-OAEP, base64 SPKI) the customer's device encrypts the
   * address with. Only the shop admin, holding the private key, can read it.
   */
  addressPublicKey: z.string().nullable(),
  /** Short fingerprint of `addressPublicKey`, to tell keys apart. */
  addressKeyFingerprint: z.string().nullable(),
  createdAt: isoDateTime,
});
export type Shop = z.infer<typeof shop>;

/**
 * Progress towards the GB's minimum (products only, cancelled orders left
 * out): `paid` counts paid, shipped and delivered orders; `ordered` adds the
 * ones still to pay. Amounts are null when the GB shows only percentages.
 */
export const goalProgress = z.object({
  target: z.number().int().positive().nullable(),
  paid: z.number().int().nonnegative().nullable(),
  ordered: z.number().int().nonnegative().nullable(),
  paidPercent: z.number().int().nonnegative(),
  orderedPercent: z.number().int().nonnegative(),
  /** The paid orders reach the minimum. */
  reached: z.boolean(),
  currency: currencyCode,
});
export type GoalProgress = z.infer<typeof goalProgress>;

/** The minimum a GB needs to go ahead; null amount = none. */
export const updateGoalRequest = z.object({
  amount: z.number().int().positive().max(100_000_000).nullable(),
  /** Customers see amounts, or only percentages. */
  showAmount: z.boolean(),
});
export type UpdateGoalRequest = z.infer<typeof updateGoalRequest>;

/** One of the people shown under "Organised by": a link when they have a @username. */
export const organizerTag = z.object({
  username: z.string().nullable(),
  name: z.string(),
});
export type OrganizerTag = z.infer<typeof organizerTag>;

export const shopConfig = shop
  .pick({
    id: true,
    slug: true,
    name: true,
    description: true,
    nameEn: true,
    descriptionEn: true,
    imageUrl: true,
    isVisible: true,
    vipOnly: true,
    allowGuests: true,
    showOrganizers: true,
    closedAt: true,
    closesAt: true,
    closingWarnHours: true,
    currency: true,
    orderFee: true,
    orderFeeLabel: true,
    vipNoFee: true,
    vipNoShipping: true,
    autoCancelHours: true,
    overpayMargin: true,
    shippingZones: true,
    checkoutFields: true,
    addressPublicKey: true,
    addressKeyFingerprint: true,
  })
  .extend({
    /** Ways to pay in crypto (empty when the shop set none). */
    paymentMethods: z.array(paymentMethod),
    /** Other ways to pay (Wise, Bizum…), checked by hand. */
    manualMethods: z.array(manualMethodView),
    /** Paying in the other token, at these rates (see `exchangeRateFor`). */
    exchangeRates,
    /** Whether the current user can manage this shop (shop admin or super-admin). */
    canManage: z.boolean(),
    /** Whether the current user is a VIP of this shop (VIP prices, no fee, VIP-only GBs). */
    isVip: z.boolean(),
    /** Closed now (closed by hand, or its scheduled closing has passed). */
    isClosed: z.boolean(),
    /**
     * Whether the current user is one of the GB's administrators (or a
     * super-admin): team, payments, visibility, copies and deleting it.
     */
    canOwn: z.boolean(),
    /** The GB's team (administrators first), as shown under "Organised by". */
    organizers: z.array(organizerTag),
    /** Progress towards the GB's minimum, or null when it has none. */
    goal: goalProgress.nullable(),
    /** Text to accept before entering the GB, or null. */
    disclaimer: z.object({ text: z.string(), version: z.number().int().positive() }).nullable(),
    /** Whether the current user may go in (accepted the current version, or an admin). */
    disclaimerAccepted: z.boolean(),
  });
export type ShopConfig = z.infer<typeof shopConfig>;

/** A shop as listed on the start screen. */
export const shopSummary = shop
  .pick({
    id: true,
    slug: true,
    name: true,
    description: true,
    nameEn: true,
    descriptionEn: true,
    imageUrl: true,
    isVisible: true,
    vipOnly: true,
    allowGuests: true,
    showOrganizers: true,
    closesAt: true,
  })
  .extend({
    canManage: z.boolean(),
    isClosed: z.boolean(),
    isVip: z.boolean(),
    /** Units in the user's cart in this shop. */
    cartItems: z.number().int().nonnegative(),
    /** The user's orders here still waiting for a payment. */
    unpaidOrders: z.number().int().nonnegative(),
    /** Progress towards the GB's minimum, or null when it has none. */
    goal: goalProgress.nullable(),
    /** The GB's admins, as shown under "Organised by". */
    organizers: z.array(organizerTag),
  });
export type ShopSummary = z.infer<typeof shopSummary>;

/** Everything about a shop that its admins (and super-admins) can see. */
export const shopAdminView = shopConfig.extend({
  sortOrder: z.number().int(),
  /** Managers ("gestores"). */
  adminIds: z.array(telegramUserId),
  /** Managers added by @username who have not opened the app yet: no permissions until then. */
  adminUsernames: z.array(z.string()),
  /** Administrators. */
  ownerIds: z.array(telegramUserId),
  ownerUsernames: z.array(z.string()),
  /** The GB's minimum (products only), and whether customers see amounts. */
  goalAmount: z.number().int().positive().nullable(),
  goalShowAmount: z.boolean(),
  paymentSetup: paymentSetup,
});
export type ShopAdminView = z.infer<typeof shopAdminView>;

/** Profile fields a shop's own admins can edit. */
export const shopProfileInput = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(1024),
  /** English versions (empty or null = show the Spanish text). */
  nameEn: z.string().trim().max(128).nullable().default(null),
  descriptionEn: z.string().trim().max(1024).nullable().default(null),
  imageUrl: z.url().nullable(),
});
export type ShopProfileInput = z.infer<typeof shopProfileInput>;

/** Fields only platform super-admins can set (create or update a shop). */
export const platformShopInput = shopProfileInput.extend({
  slug,
  isVisible: z.boolean(),
  vipOnly: z.boolean(),
  allowGuests: z.boolean().default(false),
  sortOrder: z.number().int().min(-1000).max(1000),
  /** Managers: ids and @usernames; unknown @usernames wait until they open the app. */
  admins: z.array(personRef).max(50),
  /** Administrators, the same way (none = only the super-admins). */
  owners: z.array(personRef).max(20),
});
export type PlatformShopInput = z.infer<typeof platformShopInput>;

/** An organiser creates a GB: it starts hidden, with them as its administrator. */
export const organizerShopInput = shopProfileInput.extend({ slug });
export type OrganizerShopInput = z.infer<typeof organizerShopInput>;

/** What a GB's administrators decide: who runs it and who sees it. */
export const ownerSettingsInput = z.object({
  isVisible: z.boolean(),
  vipOnly: z.boolean(),
  /** With `vipOnly`: the guests see it too. */
  allowGuests: z.boolean().default(false),
  /** Customers see "Organised by"; unchanged when left out. */
  showOrganizers: z.boolean().optional(),
  /** Administrators: at least one, unless a super-admin leaves the GB to the platform. */
  owners: z.array(personRef).max(20),
  /** Managers. */
  admins: z.array(personRef).max(50),
});
export type OwnerSettingsInput = z.infer<typeof ownerSettingsInput>;

/** Who runs a GB, with names. */
export const shopTeam = z.object({
  /** Administrators. */
  owners: z.array(person),
  /** Managers. */
  admins: z.array(person),
  /** @usernames waiting for their first visit (no permissions yet). */
  pendingOwnerUsernames: z.array(z.string()),
  pendingUsernames: z.array(z.string()),
});
export type ShopTeam = z.infer<typeof shopTeam>;

/** The platform's organisers. */
export const organizersView = z.object({
  organizers: z.array(person.extend({ ownedShops: z.number().int().nonnegative() })),
  pendingUsernames: z.array(z.string()),
});
export type OrganizersView = z.infer<typeof organizersView>;

export const updateOrganizersRequest = z.object({
  people: z.array(personRef).max(200),
  /** Those taken off the list also stop owning their GBs. */
  releaseShops: z.boolean().optional(),
});
export type UpdateOrganizersRequest = z.infer<typeof updateOrganizersRequest>;

/** Saving what checkout asks for. */
export const updateCheckoutFieldsRequest = checkoutFields;

export const updateShippingRequest = z.object({
  zones: z
    .array(shippingZone.extend({ id: z.string().min(1).max(64).optional() }))
    .max(50),
  /** VIPs do not pay shipping (unchanged when left out). */
  vipNoShipping: z.boolean().optional(),
});
export type UpdateShippingRequest = z.infer<typeof updateShippingRequest>;

/** Sets (or, with null, removes) the shop's address public key. */
export const updateAddressKeyRequest = z.object({
  publicKey: z.string().trim().min(100).max(4000).nullable(),
});
export type UpdateAddressKeyRequest = z.infer<typeof updateAddressKeyRequest>;

export const updateAutoCancelRequest = z.object({
  hours: z.number().int().min(0).max(720),
});
export type UpdateAutoCancelRequest = z.infer<typeof updateAutoCancelRequest>;

/** The GB's currency (the minimum, the margin and new products use it). */
export const updateShopCurrencyRequest = z.object({ currency: z.enum(['USDC', 'EURC']) });

/** The GB's overpayment margin, in minor units (up to 100.00). */
export const updateOverpayMarginRequest = z.object({
  amount: z.number().int().min(0).max(10_000),
});

/** When an unpaid order will be cancelled, or null when it will not be. */
export function payBefore(
  order: { status: string; amountPaid: number; amountSubmitted: number; updatedAt: string },
  autoCancelHours: number,
): Date | null {
  if (autoCancelHours <= 0 || order.status !== 'pending') return null;
  if (order.amountPaid > 0 || order.amountSubmitted > 0) return null;
  return new Date(Date.parse(order.updatedAt) + autoCancelHours * 60 * 60 * 1000);
}

/** Replaces the shop's payment setup; each accepted network needs its address. */
export const updatePaymentSetupRequest = paymentSetup.refine(
  (setup) => setup.accepted.every((a) => addressFor(setup, a.chain) !== null),
  { message: 'Each accepted network needs its receiving address' },
);

/**
 * What the customer types (postal address and other details); encrypted on
 * their device before it is sent. Orders from before `email` existed lack it.
 */
export interface DeliveryAddress {
  name: string;
  email?: string;
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  region: string;
  country: string;
  phone: string;
  notes: string;
}

/** Shipping cost of an order with `itemsTotal` worth of products in `zone`. */
export function shippingCost(
  zone: Pick<ShippingZone, 'price' | 'freeFrom'>,
  itemsTotal: number,
  /** A VIP in a GB where VIPs do not pay shipping. */
  free = false,
): number {
  if (free) return 0;
  return zone.freeFrom !== null && itemsTotal >= zone.freeFrom ? 0 : zone.price;
}

/**
 * Platform-wide data retention: how long personal data is kept. A cleanup
 * runs regularly and can be run by hand from Platform admin.
 */
export const retentionSettings = z.object({
  /** Days after an order is delivered or cancelled before its address is deleted and it is unlinked from the customer (the @username stays). */
  addressRetentionDays: z.number().int().min(1).max(3650),
  /** Days an untouched cart is kept. */
  cartRetentionDays: z.number().int().min(1).max(3650),
  /** Days without opening the app before a user with no orders is deleted. */
  inactiveUserDays: z.number().int().min(1).max(3650),
});
export type RetentionSettings = z.infer<typeof retentionSettings>;

export const retentionStatus = retentionSettings.extend({
  lastRunAt: z.string().nullable(),
});
export type RetentionStatus = z.infer<typeof retentionStatus>;

/** What one cleanup run did. */
export const retentionReport = z.object({
  ordersAnonymized: z.number().int().nonnegative(),
  cartsDeleted: z.number().int().nonnegative(),
  usersDeleted: z.number().int().nonnegative(),
  ranAt: z.string(),
});
export type RetentionReport = z.infer<typeof retentionReport>;

/** Whether a GB is closed at `now`: closed by hand, or past its scheduled closing. */
export function isClosedAt(
  shop: { closedAt: string | Date | null; closesAt: string | Date | null },
  now: Date = new Date(),
): boolean {
  if (shop.closedAt) return true;
  return shop.closesAt !== null && new Date(shop.closesAt).getTime() <= now.getTime();
}

/** Sets (or, with null, clears) the scheduled closing of a GB. */
export const updateClosingRequest = z.object({
  closesAt: isoDateTime.nullable(),
  /** Hours before the closing when the big notice appears (default: keep). */
  warnHours: z.number().int().min(0).max(720).optional(),
});
export type UpdateClosingRequest = z.infer<typeof updateClosingRequest>;

/** What closing a GB now would do. */
export const closePreview = z.object({
  /** Orders with nothing paid nor sent: deleted. */
  unpaidOrders: z.number().int().nonnegative(),
  /** Customers' carts: emptied. */
  carts: z.number().int().nonnegative(),
  /** Change requests waiting for approval: rejected. */
  pendingChanges: z.number().int().nonnegative(),
  /** Payments still to review (they stay). */
  paymentsToReview: z.number().int().nonnegative(),
});
export type ClosePreview = z.infer<typeof closePreview>;

/** Sets (or, with an empty text, removes) the GB's disclaimer. */
export const updateDisclaimerRequest = z.object({
  text: z.string().trim().max(4000),
  /** Everyone must accept it again (otherwise: a minor correction). */
  askAgain: z.boolean(),
});
export type UpdateDisclaimerRequest = z.infer<typeof updateDisclaimerRequest>;

export const acceptDisclaimerRequest = z.object({ version: z.number().int().positive() });

/** The disclaimer as admins see it. */
export const disclaimerAdminView = z.object({
  text: z.string(),
  version: z.number().int().nonnegative(),
  /** People who accepted the current version. */
  accepted: z.number().int().nonnegative(),
});
export type DisclaimerAdminView = z.infer<typeof disclaimerAdminView>;
