import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  primaryKey,
  pgEnum,
  serial,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type {
  Blacklist,
  OrderChangeRequest,
  PaymentLogEntry,
  PriceTier,
  ProductOption,
  ShippingZone,
  PaymentCheck,
  PaymentSetup,
  VipClub,
  WebRole,
} from '@tma-shop/shared';


export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'awaiting_payment',
  'paid',
  'cancelled',
  'shipped',
  'fulfilled',
]);

export const shops = pgTable('shops', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** URL-friendly unique name. */
  slug: text('slug').notNull().unique('shops_slug_unique'),
  /** Spanish (the main text). */
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** English version, for apps not in Spanish (null = same as Spanish). */
  nameEn: text('name_en'),
  descriptionEn: text('description_en'),
  imageUrl: text('image_url'),
  /** Hidden shops are only visible to their admins and platform super-admins. */
  isVisible: boolean('is_visible').notNull().default(true),
  /** Visible shops only show to VIP club members (and admins). */
  vipOnly: boolean('vip_only').notNull().default(false),
  /** With `vipOnly`: the guests see it too (at normal prices). */
  allowGuests: boolean('allow_guests').notNull().default(false),
  /** Closed: no new orders; existing ones can still be looked at and managed. */
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /** Scheduled closing: from this moment the GB is closed. */
  closesAt: timestamp('closes_at', { withTimezone: true }),
  /** Hours before a scheduled closing when customers get the big notice. */
  closingWarnHours: integer('closing_warn_hours').notNull().default(24),
  /** Minimum (products, minor units) for the GB to go ahead; null = none. */
  goalAmount: integer('goal_amount'),
  /** Customers see the amounts of the goal, or only percentages. */
  goalShowAmount: boolean('goal_show_amount').notNull().default(true),
  /** Highest milestone (50, 80, 100) already announced to the buyers. */
  goalNotified: integer('goal_notified').notNull().default(0),
  /** The shop's own VIP club. */
  vipClub: jsonb('vip_club').$type<VipClub>().notNull().default({ groups: [], userIds: [], usernames: [] }),
  /** Whether members of the platform's VIP club count as VIPs here too. */
  useGlobalVipClub: boolean('use_global_vip_club').notNull().default(true),
  /** Guests: may see the GB when it is "VIP and guests only", without VIP prices. */
  guestList: jsonb('guest_list').$type<VipClub>().notNull().default({ groups: [], userIds: [], usernames: [] }),
  /** Whether the platform's guests count as guests here too. */
  useGlobalGuests: boolean('use_global_guests').notNull().default(true),
  /** People who must not see this GB (ids, and @usernames not seen yet). */
  blacklist: jsonb('blacklist').$type<Blacklist>().notNull().default({ userIds: [], usernames: [] }),
  sortOrder: integer('sort_order').notNull().default(0),
  /** Telegram ids of this GB's managers ("gestores"): they run it day to day. */
  adminIds: jsonb('admin_ids').$type<number[]>().notNull().default([]),
  /** Managers added by @username who have not opened the app yet (lowercase, no "@"). */
  adminUsernames: jsonb('admin_usernames').$type<string[]>().notNull().default([]),
  /**
   * Its administrators: also its team, payments, visibility, copies and
   * deleting it (none = only the platform super-admins).
   */
  ownerIds: jsonb('owner_ids').$type<number[]>().notNull().default([]),
  /** Administrators added by @username who have not opened the app yet. */
  ownerUsernames: jsonb('owner_usernames').$type<string[]>().notNull().default([]),
  /** Receiving addresses and accepted networks/tokens (null = none yet). */
  paymentSetup: jsonb('payment_setup').$type<PaymentSetup>(),
  currency: text('currency').notNull().default('USDC'),
  /** Fixed fee added once to every order (minor units of the order's token). */
  orderFee: integer('order_fee').notNull().default(0),
  /** Paying up to this much too much counts as paying the price (minor units, 0 = off). */
  overpayMargin: integer('overpay_margin').notNull().default(0),
  orderFeeLabel: text('order_fee_label').notNull().default('Service fee'),
  /** The GB's VIPs do not pay the per-order fee. */
  vipNoFee: boolean('vip_no_fee').notNull().default(false),
  /** The GB's VIPs do not pay shipping. */
  vipNoShipping: boolean('vip_no_shipping').notNull().default(false),
  /** Text customers must accept before entering the GB (null = none). */
  disclaimer: text('disclaimer'),
  /** Goes up when customers must accept the text again. */
  disclaimerVersion: integer('disclaimer_version').notNull().default(0),
  /** Unpaid orders are cancelled after this many hours without activity (0 = never). */
  autoCancelHours: integer('auto_cancel_hours').notNull().default(48),
  /** Shipping zones with a flat cost per order. */
  shippingZones: jsonb('shipping_zones').$type<ShippingZone[]>().notNull().default([]),
  /** RSA-OAEP public key (base64 SPKI) used to encrypt delivery addresses. */
  addressPublicKey: text('address_public_key'),
  addressKeyFingerprint: text('address_key_fingerprint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [unique('categories_shop_slug_unique').on(table.shopId, table.slug)],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    slug: text('slug').notNull(),
    /** Spanish (the main text). */
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** English version, shown to everyone whose app is not in Spanish (null = same as Spanish). */
    titleEn: text('title_en'),
    descriptionEn: text('description_en'),
    /** Price in cents of the token (1290 = 12.90 USDC). */
    price: integer('price').notNull(),
    /** Fixed price for the GB's VIPs (no tiers); NULL = none. */
    vipPrice: integer('vip_price'),
    currency: text('currency').notNull(),
    imageUrl: text('image_url'),
    /** NULL means the product is not stock-tracked. Unused when it has variants. */
    stock: integer('stock'),
    isActive: boolean('is_active').notNull().default(true),
    /** Only the GB's VIPs see it and can buy it; for everyone else it does not exist. */
    vipOnly: boolean('vip_only').notNull().default(false),
    /** Minimum units per order, all variants together (1 = none). */
    minQuantity: integer('min_quantity').notNull().default(1),
    /** Option groups (Color, Size…); empty for a product without variants. */
    options: jsonb('options').$type<ProductOption[]>().notNull().default([]),
    /** Quantity breaks on the product's price, sorted by `minQty`. */
    priceTiers: jsonb('price_tiers').$type<PriceTier[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('products_shop_slug_unique').on(table.shopId, table.slug)],
);

/** One combination of a product's option values, with optional own price and stock. */
export const productVariants = pgTable('product_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  /** One value per option, in the product's option order. */
  optionValues: jsonb('option_values').$type<string[]>().notNull(),
  /** Own price; NULL = the product's price. */
  price: integer('price'),
  /** Own VIP price; NULL = the product's VIP price. */
  vipPrice: integer('vip_price'),
  /** NULL = not stock-tracked. */
  stock: integer('stock'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const users = pgTable('users', {
  telegramId: bigint('telegram_id', { mode: 'number' }).primaryKey(),
  firstName: text('first_name').notNull(),
  username: text('username'),
  languageCode: text('language_code'),
  /** Language chosen in the app ('en' | 'es' | 'it' | 'pt'); null = follow Telegram. */
  preferredLang: text('preferred_lang'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Last time they opened the Mini App; inactive users are deleted (retention). */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('carts_shop_user_unique').on(table.shopId, table.userId)],
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),
  },
  (table) => [
    unique('cart_items_cart_product_variant_unique')
      .on(table.cartId, table.productId, table.variantId)
      .nullsNotDistinct(),
  ],
);

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  /** Customer; null once the order is anonymized (data retention). */
  userId: bigint('user_id', { mode: 'number' }).references(() => users.telegramId, {
    onDelete: 'set null',
  }),
  status: orderStatusEnum('status').notNull().default('pending'),
  /** Placed by a VIP: VIP prices apply to it, also when it is changed later. */
  isVip: boolean('is_vip').notNull().default(false),
  /** Total including `fee`. */
  total: integer('total').notNull(),
  /** Per-order fee charged once, frozen at creation. */
  fee: integer('fee').notNull().default(0),
  /** Shipping charged once, frozen at creation (0 = free or not shipped). */
  shipping: integer('shipping').notNull().default(0),
  shippingZoneName: text('shipping_zone_name'),
  /** Address encrypted on the customer's device; the server cannot read it. */
  encryptedAddress: text('encrypted_address'),
  addressKeyFingerprint: text('address_key_fingerprint'),
  currency: text('currency').notNull(),
  /** Crypto payment method label chosen by the customer, e.g. "USDC · Base". */
  paymentNetwork: text('payment_network'),
  /** Crypto transaction hash submitted by the customer for manual review. */
  paymentTxHash: text('payment_tx_hash'),
  /** Payment method id of that transaction, e.g. `usdc-base`. */
  paymentMethodId: text('payment_method_id'),
  /** Result of the automatic on-chain check of that transaction. */
  paymentCheck: jsonb('payment_check').$type<PaymentCheck>(),
  /** The transaction under review pays in the other token: which one and at what rate (×10 000). */
  paymentExchange: jsonb('payment_exchange').$type<{ token: string; rate: number }>(),
  /** Customer's Telegram username (without @) given at checkout. */
  contactUsername: text('contact_username'),
  /** Shipment tracking number or link, set when the order is shipped. */
  trackingNumber: text('tracking_number'),
  /** Last message from the shop to the customer about this order. */
  statusNote: text('status_note'),
  /** Confirmed money received, net of refunds (minor units of `currency`). */
  amountPaid: integer('amount_paid').notNull().default(0),
  /** Amount covered by the transaction currently awaiting verification. */
  amountSubmitted: integer('amount_submitted').notNull().default(0),
  /** Whether tracked stock was already decremented for this order's items. */
  stockApplied: boolean('stock_applied').notNull().default(false),
  /** Customer's pending modification, awaiting admin approval. */
  changeRequest: jsonb('change_request').$type<OrderChangeRequest>(),
  /** Confirmed payments and refunds, oldest first. */
  paymentLog: jsonb('payment_log').$type<PaymentLogEntry[]>().notNull().default([]),
  /** When it was delivered or cancelled; retention counts from here. */
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /** When the address and the link to the customer were removed (retention). */
  anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
  /** When the bot reminded the customer to pay (sent once per order). */
  paymentReminderAt: timestamp('payment_reminder_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Platform-wide settings (a single row, id = 1). */
export const platformSettings = pgTable('platform_settings', {
  id: integer('id').primaryKey().default(1),
  /** Days after an order is closed before its address and customer link go. */
  addressRetentionDays: integer('address_retention_days').notNull().default(30),
  /** Days an untouched cart is kept. */
  cartRetentionDays: integer('cart_retention_days').notNull().default(30),
  /** Days without opening the app before a user with no orders is deleted. */
  inactiveUserDays: integer('inactive_user_days').notNull().default(30),
  lastRetentionRunAt: timestamp('last_retention_run_at', { withTimezone: true }),
  /** The platform-wide VIP club (shops can count its members as their VIPs). */
  vipClub: jsonb('vip_club').$type<VipClub>().notNull().default({ groups: [], userIds: [], usernames: [] }),
  /** The platform-wide guests (shops can count them as their guests). */
  guestList: jsonb('guest_list').$type<VipClub>().notNull().default({ groups: [], userIds: [], usernames: [] }),
  /** Organisers: may create GBs and run the ones they own. */
  organizerIds: jsonb('organizer_ids').$type<number[]>().notNull().default([]),
  /** Organisers added by @username not seen yet (lowercase, no "@"). */
  organizerUsernames: jsonb('organizer_usernames').$type<string[]>().notNull().default([]),
  /** People who must not see any GB. */
  blacklist: jsonb('blacklist').$type<Blacklist>().notNull().default({ userIds: [], usernames: [] }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'restrict' }),
  /** Snapshot of the product title (Spanish) and its English version. */
  title: text('title').notNull(),
  titleEn: text('title_en'),
  variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
  /** Snapshot of the variant's label at order time, e.g. "Red / M". */
  variantLabel: text('variant_label'),
  unitPrice: integer('unit_price').notNull(),
  quantity: integer('quantity').notNull(),
  subtotal: integer('subtotal').notNull(),
});

// --- relations (used by Drizzle's relational query API) ---

/**
 * A file someone sent to the bot (a products CSV or a GB backup), kept for a
 * day so the Mini App can open it for import. Deleted once used.
 */
export const botUploads = pgTable(
  'bot_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    /** `csv` (products) or `backup` (a GB as JSON). */
    kind: text('kind').$type<'csv' | 'backup'>().notNull(),
    fileName: text('file_name').notNull(),
    content: text('content').notNull(),
    /** For a CSV: the GB it is for, once chosen. */
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'cascade' }),
    /** For a CSV and someone running several GBs: the GBs offered as buttons. */
    shopChoices: jsonb('shop_choices').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('bot_uploads_expires_idx').on(table.expiresAt)],
);

/** A message an admin sent to a GB's buyers through the bot, and how it went. */
export const broadcasts = pgTable(
  'broadcasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    senderId: bigint('sender_id', { mode: 'number' }).notNull(),
    /** Who it went to: `orders`, `paid`, `unpaid` or `cart`. */
    audience: text('audience').notNull(),
    text: text('text').notNull(),
    recipients: integer('recipients').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    status: text('status').$type<'sending' | 'done'>().notNull().default('sending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('broadcasts_shop_idx').on(table.shopId, table.createdAt)],
);

/** Who accepted a GB's disclaimer, and which version. Goes with the user. */
export const disclaimerAcceptances = pgTable(
  'disclaimer_acceptances',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.shopId, table.userId] })],
);

/** Messages the bot deletes from a chat later (e.g. shipping lists with addresses). */
export const expiringBotMessages = pgTable(
  'expiring_bot_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: integer('message_id').notNull(),
    deleteAt: timestamp('delete_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('expiring_bot_messages_delete_idx').on(table.deleteAt)],
);

export const shopsRelations = relations(shops, ({ many }) => ({
  categories: many(categories),
  products: many(products),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  shop: one(shops, { fields: [categories.shopId], references: [shops.id] }),
  products: many(products),
}));

export const productsRelations = relations(products, ({ one }) => ({
  shop: one(shops, { fields: [products.shopId], references: [shops.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
}));

export const cartsRelations = relations(carts, ({ one, many }) => ({
  user: one(users, { fields: [carts.userId], references: [users.telegramId] }),
  items: many(cartItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
  product: one(products, { fields: [cartItems.productId], references: [products.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.userId], references: [users.telegramId] }),
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
}));

/**
 * Platform super-admins who sign in on the web (username, password and an
 * authenticator code) instead of through Telegram. In sessions they appear
 * with a negative id (-id) so they never collide with Telegram users.
 */
export const webAdmins = pgTable('web_admins', {
  id: serial('id').primaryKey(),
  /** Lowercase. */
  username: text('username').notNull().unique(),
  /**
   * `platform`: everything; `platform_limited`: everything but managing web
   * accounts; `linked`: what its Telegram account may do in the bot.
   */
  role: text('role').$type<WebRole>().notNull().default('platform'),
  /** `linked` accounts: the Telegram user they act as (one web account each). */
  telegramId: bigint('telegram_id', { mode: 'number' })
    .unique()
    .references(() => users.telegramId, { onDelete: 'cascade' }),
  /** scrypt: "salt:hash", both base64. */
  passwordHash: text('password_hash').notNull(),
  /** Base32 secret of the authenticator app (TOTP). */
  totpSecret: text('totp_secret').notNull(),
  /** Last 30-second step whose code was used: a code works only once. */
  totpLastStep: bigint('totp_last_step', { mode: 'number' }).notNull().default(0),
  /** Goes up on a reset, so sessions opened before stop working. */
  sessionVersion: integer('session_version').notNull().default(1),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  /** Last notice of the inbox this admin has seen. */
  noticesSeenId: integer('notices_seen_id').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Inbox of the web administrators: what the bot tells the platform admins in
 * Telegram (new or deleted GBs, wallet changes, orders of GBs without a team),
 * in every app language.
 */
export const webNotices = pgTable(
  'web_notices',
  {
    id: serial('id').primaryKey(),
    shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'set null' }),
    texts: jsonb('texts').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('web_notices_created_at_idx').on(table.createdAt)],
);
