import { asc, eq, or, sql } from 'drizzle-orm';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import type {
  OrganizerShopInput,
  OwnerSettingsInput,
  PlatformShopInput,
  ShopAdminView,
  ShopConfig,
  ShopProfileInput,
  ShopSummary,
  UpdateShippingRequest,
  PaymentSetup,
} from '@tma-shop/shared';
import { EMPTY_PAYMENT_SETUP, isClosedAt, NO_EXCHANGE } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import type { Env } from '../config/env.js';
import { cartItems, carts, categories, orders, products, shops } from '../db/schema.js';
import { toShopAdminDTO, toShopConfigDTO, toShopSummaryDTO } from '../db/mappers.js';
import { ApiError } from '../lib/errors.js';
import { createVipChecker } from './vip.js';
import { loadPeople, organizerTags, resolvePeople } from './team.js';
import { goalProgressOf, goalTotals } from './goal.js';

export type ShopRow = typeof shops.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Platform super-admins manage every shop: those in ADMIN_TELEGRAM_IDS and the
 * web admins (negative session ids, only ever issued by the web sign-in).
 */
export function isSuperAdmin(env: Env, userId: number | undefined): boolean {
  return userId !== undefined && (userId < 0 || env.ADMIN_TELEGRAM_IDS.includes(userId));
}

/** Everyone who runs a GB: its administrators, then its managers. */
export function teamIds(shop: Pick<ShopRow, 'ownerIds' | 'adminIds'>): number[] {
  return [...new Set([...shop.ownerIds, ...shop.adminIds])];
}

/** A GB's administrators and managers, plus platform super-admins. */
export function canManageShop(env: Env, shop: ShopRow, userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return isSuperAdmin(env, userId) || teamIds(shop).includes(userId);
}

/** Who gets the bot's messages about a shop's orders: its team, else the super-admins. */
export function shopNotificationChatIds(env: Env, shop: ShopRow): number[] {
  const team = teamIds(shop);
  return team.length > 0 ? team : env.ADMIN_TELEGRAM_IDS;
}

/** Finds the GB a request is for: `ref` (the `X-Shop` header) is its id or link name. */
export async function resolveShop(db: Database, ref: string | undefined): Promise<ShopRow> {
  const value = ref?.trim();
  const shop = value
    ? await db.query.shops.findFirst({
        where: UUID_RE.test(value)
          ? or(eq(shops.id, value), eq(shops.slug, value))
          : eq(shops.slug, value),
      })
    : undefined;
  if (!shop) throw ApiError.notFound('Shop not found');
  return shop;
}

/**
 * Shops shown on the start screen: visible ones (VIP-only ones just for their
 * VIPs), plus any the user manages.
 */
export async function listShops(db: Database, env: Env, userId: number): Promise<ShopSummary[]> {
  const rows = await db
    .select()
    .from(shops)
    .orderBy(asc(shops.sortOrder), asc(shops.createdAt));
  const isVip = createVipChecker(db, env, userId);
  const [activity, people] = await Promise.all([
    userActivity(db, userId),
    loadPeople(
      db,
      rows.flatMap((row) => teamIds(row)),
    ),
  ]);
  // Progress of the GBs with a minimum, in one query.
  const totals = await goalTotals(
    db,
    rows.filter((row) => row.goalAmount).map((row) => row.id),
  );
  const result: ShopSummary[] = [];
  for (const row of rows) {
    const canManage = canManageShop(env, row, userId);
    const vip = row.isVisible && row.vipOnly ? await isVip(row) : false;
    const mine = activity.get(row.id);
    // A closed GB stays listed only for those who have orders in it.
    const closedForThem = isClosedAt(row) && (mine?.orders ?? 0) === 0;
    if (canManage || (row.isVisible && (!row.vipOnly || vip) && !closedForThem)) {
      result.push(
        toShopSummaryDTO(
          row,
          canManage,
          vip,
          mine,
          organizerTags(row, people),
          goalProgressOf(row, totals.get(row.id), canManage),
        ),
      );
    }
  }
  return result;
}

/** Per shop: units in the user's cart and orders still waiting for a payment. */
async function userActivity(
  db: Database,
  userId: number,
): Promise<Map<string, { cartItems: number; unpaidOrders: number; orders: number }>> {
  const [cartRows, orderRows] = await Promise.all([
    db
      .select({ shopId: carts.shopId, units: sql<number>`coalesce(sum(${cartItems.quantity}), 0)::int` })
      .from(carts)
      .innerJoin(cartItems, eq(cartItems.cartId, carts.id))
      .where(eq(carts.userId, userId))
      .groupBy(carts.shopId),
    db
      .select({
        shopId: orders.shopId,
        count: sql<number>`count(*)::int`,
        unpaid: sql<number>`count(*) filter (where ${orders.status} = 'pending' and ${orders.total} - ${orders.amountPaid} > 0)::int`,
      })
      .from(orders)
      .where(eq(orders.userId, userId))
      .groupBy(orders.shopId),
  ]);
  type Activity = { cartItems: number; unpaidOrders: number; orders: number };
  const result = new Map<string, Activity>();
  const entry = (shopId: string): Activity => {
    let value = result.get(shopId);
    if (!value) {
      value = { cartItems: 0, unpaidOrders: 0, orders: 0 };
      result.set(shopId, value);
    }
    return value;
  };
  for (const row of cartRows) entry(row.shopId).cartItems = Number(row.units);
  for (const row of orderRows) {
    entry(row.shopId).unpaidOrders = Number(row.unpaid);
    entry(row.shopId).orders = Number(row.count);
  }
  return result;
}

export function getShopConfig(
  shop: ShopRow,
  canManage: boolean,
  isVip = false,
  extra: Parameters<typeof toShopConfigDTO>[3] = {},
): ShopConfig {
  return toShopConfigDTO(shop, canManage, isVip, extra);
}

export function getShopAdminView(shop: ShopRow): ShopAdminView {
  return toShopAdminDTO(shop);
}

async function updateShop(
  db: Database,
  shopId: string,
  values: Partial<typeof shops.$inferInsert>,
): Promise<ShopRow> {
  const [row] = await db.update(shops).set(values).where(eq(shops.id, shopId)).returning();
  if (!row) throw ApiError.notFound('Shop not found');
  return row;
}

/** Sets the fixed fee added once to every new order (0 = no fee) and its label. */
export async function updateOrderFee(
  db: Database,
  shopId: string,
  input: { orderFee: number; orderFeeLabel: string; vipNoFee?: boolean | undefined },
): Promise<ShopAdminView> {
  const row = await updateShop(db, shopId, {
    orderFee: input.orderFee,
    orderFeeLabel: input.orderFeeLabel,
    ...(input.vipNoFee === undefined ? {} : { vipNoFee: input.vipNoFee }),
  });
  return toShopAdminDTO(row);
}

/** Hours without activity before an unpaid order is cancelled (0 = never). */
export async function updateAutoCancel(
  db: Database,
  shopId: string,
  hours: number,
): Promise<ShopAdminView> {
  return toShopAdminDTO(await updateShop(db, shopId, { autoCancelHours: hours }));
}

/** Name, description and image — editable by the shop's own admins. */
/** An optional English text: empty means "none" (the Spanish one is shown). */
export function optionalText(text: string | null | undefined): string | null {
  return text?.trim() ? text.trim() : null;
}

export async function updateShopProfile(
  db: Database,
  shopId: string,
  input: ShopProfileInput,
): Promise<ShopAdminView> {
  return toShopAdminDTO(
    await updateShop(db, shopId, {
      ...input,
      nameEn: optionalText(input.nameEn),
      descriptionEn: optionalText(input.descriptionEn),
    }),
  );
}

/**
 * Replaces the shop's receiving addresses and accepted networks. Returns the
 * shop before and after, so callers can warn admins when an address changed.
 */
export async function updatePaymentSetup(
  db: Database,
  shopId: string,
  setup: PaymentSetup,
): Promise<{ before: PaymentSetup; view: ShopAdminView }> {
  const current = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!current) throw ApiError.notFound('Shop not found');
  const names = new Set((setup.manual ?? []).map((m) => m.name.trim().toLowerCase()));
  if (names.size !== (setup.manual ?? []).length) {
    throw ApiError.badRequest('invalid_methods', 'Two payment methods have the same name');
  }
  const ids = new Set<string>();
  const cleaned: PaymentSetup = {
    evmAddress: setup.evmAddress?.trim() || null,
    solanaAddress: setup.solanaAddress?.trim() || null,
    accepted: setup.accepted.filter(
      (a, i, all) => all.findIndex((b) => b.chain === a.chain && b.token === a.token) === i,
    ),
    // Manual methods keep their id (orders point at it); repeated ones get a new one.
    manual: (setup.manual ?? []).map((m) => {
      const id = ids.has(m.id) ? randomUUID() : m.id;
      ids.add(id);
      return { id, name: m.name.trim(), instructions: m.instructions.trim(), isActive: m.isActive };
    }),
    exchange: setup.exchange ?? current.paymentSetup?.exchange ?? NO_EXCHANGE,
  };
  const row = await updateShop(db, shopId, { paymentSetup: cleaned });
  return { before: current.paymentSetup ?? EMPTY_PAYMENT_SETUP, view: toShopAdminDTO(row) };
}

/** Replaces the shop's shipping zones; zones keep their id, new ones get one. */
export async function updateShippingZones(
  db: Database,
  shopId: string,
  zones: UpdateShippingRequest['zones'],
  vipNoShipping?: boolean,
): Promise<ShopAdminView> {
  const names = new Set(zones.map((z) => z.name.trim().toLowerCase()));
  if (names.size !== zones.length) {
    throw ApiError.badRequest('invalid_zones', 'Two shipping zones have the same name');
  }
  const cleaned = zones.map((z) => ({
    id: z.id ?? randomUUID(),
    name: z.name.trim(),
    price: z.price,
    freeFrom: z.freeFrom,
    isActive: z.isActive,
  }));
  return toShopAdminDTO(
    await updateShop(db, shopId, {
      shippingZones: cleaned,
      ...(vipNoShipping === undefined ? {} : { vipNoShipping }),
    }),
  );
}

/** Short fingerprint of a public key: first 16 hex chars of SHA-256 over its DER bytes. */
export function keyFingerprint(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * Checks an address public key (PEM or base64 SPKI, RSA ≥ 2048 bits) and
 * returns it as base64 DER with its fingerprint.
 */
export function parseAddressKey(publicKey: string): { base64: string; fingerprint: string } {
  const base64 = publicKey
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  let der: Buffer;
  try {
    der = Buffer.from(base64, 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== 'rsa' || bits < 2048) {
      throw new Error('weak');
    }
  } catch {
    throw ApiError.badRequest(
      'invalid_key',
      'That is not an RSA public key of 2048 bits or more (SPKI / "BEGIN PUBLIC KEY")',
    );
  }
  return { base64: der.toString('base64'), fingerprint: keyFingerprint(der) };
}

/**
 * Sets the shop's address public key (PEM or base64 SPKI, RSA ≥ 2048 bits), or
 * removes it with null. The private key never reaches the server.
 */
export async function updateAddressKey(
  db: Database,
  shopId: string,
  publicKey: string | null,
): Promise<ShopAdminView> {
  if (publicKey === null) {
    return toShopAdminDTO(
      await updateShop(db, shopId, { addressPublicKey: null, addressKeyFingerprint: null }),
    );
  }
  const key = parseAddressKey(publicKey);
  return toShopAdminDTO(
    await updateShop(db, shopId, {
      addressPublicKey: key.base64,
      addressKeyFingerprint: key.fingerprint,
    }),
  );
}

// --- Platform (super-admin) ---------------------------------------------------

export async function assertSlugFree(db: Database, slug: string, exceptId?: string): Promise<void> {
  const taken = await db.query.shops.findFirst({ where: eq(shops.slug, slug) });
  if (taken && taken.id !== exceptId) {
    throw ApiError.conflict('slug_taken', `A shop with the slug "${slug}" already exists`);
  }
}

/**
 * Typed administrators and managers → ids now, and @usernames still to come.
 * Someone in both lists is an administrator.
 */
export async function teamFields(
  db: Database,
  owners: readonly string[],
  admins: readonly string[],
): Promise<{ ownerIds: number[]; ownerUsernames: string[]; adminIds: number[]; adminUsernames: string[] }> {
  const [o, a] = await Promise.all([resolvePeople(db, owners), resolvePeople(db, admins)]);
  return {
    ownerIds: o.ids,
    ownerUsernames: o.pending,
    adminIds: a.ids.filter((id) => !o.ids.includes(id)),
    adminUsernames: a.pending.filter((u) => !o.pending.includes(u)),
  };
}

/** Position for a new GB: after all the others. */
export async function nextSortOrder(db: Database): Promise<number> {
  const [row] = await db.select({ max: sql<number | null>`max(${shops.sortOrder})` }).from(shops);
  return Math.min(1000, (row?.max ?? -1) + 1);
}

/**
 * Moves a GB one place up or down the start screen: the list is numbered
 * 0, 1, 2… in its current order and the GB swaps places with its neighbour.
 */
export async function moveShop(
  db: Database,
  shopId: string,
  direction: 'up' | 'down',
): Promise<ShopAdminView[]> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: shops.id })
      .from(shops)
      .orderBy(asc(shops.sortOrder), asc(shops.createdAt));
    const index = rows.findIndex((r) => r.id === shopId);
    if (index === -1) throw ApiError.notFound('Shop not found');
    const target = direction === 'up' ? index - 1 : index + 1;
    const ids = rows.map((r) => r.id);
    if (target >= 0 && target < ids.length) {
      [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
    }
    for (const [position, id] of ids.entries()) {
      await tx.update(shops).set({ sortOrder: Math.min(position, 1000) }).where(eq(shops.id, id));
    }
  });
  return listAllShops(db);
}

export async function listAllShops(db: Database): Promise<ShopAdminView[]> {
  const rows = await db
    .select()
    .from(shops)
    .orderBy(asc(shops.sortOrder), asc(shops.createdAt));
  return rows.map(toShopAdminDTO);
}

function platformValues(input: PlatformShopInput) {
  const { admins: _admins, owners: _owners, ...rest } = input;
  return { ...rest, nameEn: optionalText(rest.nameEn), descriptionEn: optionalText(rest.descriptionEn) };
}

export async function createShop(db: Database, input: PlatformShopInput): Promise<ShopAdminView> {
  await assertSlugFree(db, input.slug);
  const [row] = await db
    .insert(shops)
    .values({
      ...platformValues(input),
      // New GBs go to the end of the list (moved with the arrows in Platform).
      sortOrder: await nextSortOrder(db),
      ...(await teamFields(db, input.owners, input.admins)),
      currency: 'USDC',
    })
    .returning();
  if (!row) throw new Error('Failed to create shop');
  return toShopAdminDTO(row);
}

export async function updatePlatformShop(
  db: Database,
  shopId: string,
  input: PlatformShopInput,
): Promise<ShopAdminView> {
  await assertSlugFree(db, input.slug, shopId);
  return toShopAdminDTO(
    await updateShop(db, shopId, {
      ...platformValues(input),
      ...(await teamFields(db, input.owners, input.admins)),
    }),
  );
}

/** An organiser's new GB: hidden, with them as its administrator. */
export async function createOrganizerShop(
  db: Database,
  ownerId: number,
  input: OrganizerShopInput,
): Promise<ShopAdminView> {
  await assertSlugFree(db, input.slug);
  const [row] = await db
    .insert(shops)
    .values({
      ...input,
      nameEn: optionalText(input.nameEn),
      descriptionEn: optionalText(input.descriptionEn),
      isVisible: false,
      vipOnly: false,
      sortOrder: await nextSortOrder(db),
      ownerIds: [ownerId],
      currency: 'USDC',
    })
    .returning();
  if (!row) throw new Error('Failed to create shop');
  return toShopAdminDTO(row);
}

/**
 * What the administrators decide: the team (ids and @usernames) and who sees
 * the GB. There is always at least one administrator who has opened the app,
 * except when a super-admin (always in charge) leaves the GB without one.
 */
export async function updateOwnerSettings(
  db: Database,
  shopId: string,
  input: OwnerSettingsInput,
  bySuperAdmin = false,
): Promise<{ before: ShopRow; after: ShopRow }> {
  const before = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!before) throw ApiError.notFound('Shop not found');
  const team = await teamFields(db, input.owners, input.admins);
  if (team.ownerIds.length === 0 && !bySuperAdmin) {
    throw ApiError.badRequest(
      'no_owner',
      'The GB needs at least one administrator who has already opened the app',
    );
  }
  const after = await updateShop(db, shopId, {
    isVisible: input.isVisible,
    vipOnly: input.vipOnly,
    ...team,
  });
  return { before, after };
}

/** Deletes a shop with everything in it — only while it has no orders. */
export async function deleteShop(db: Database, shopId: string): Promise<void> {
  const withOrders = await db.query.orders.findFirst({ where: eq(orders.shopId, shopId) });
  if (withOrders) {
    throw ApiError.conflict(
      'shop_has_orders',
      'This shop has orders and cannot be deleted. Hide it instead.',
    );
  }
  const deleted = await db.delete(shops).where(eq(shops.id, shopId)).returning({ id: shops.id });
  if (deleted.length === 0) throw ApiError.notFound('Shop not found');
}

export interface ShopContents {
  orders: number;
  products: number;
  categories: number;
  carts: number;
}

/** What deleting a shop would take with it. */
export async function shopContents(db: Database, shopId: string): Promise<ShopContents> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw ApiError.notFound('Shop not found');
  const n = sql<number>`count(*)::int`;
  const [o] = await db.select({ n }).from(orders).where(eq(orders.shopId, shopId));
  const [p] = await db.select({ n }).from(products).where(eq(products.shopId, shopId));
  const [k] = await db.select({ n }).from(categories).where(eq(categories.shopId, shopId));
  const [c] = await db.select({ n }).from(carts).where(eq(carts.shopId, shopId));
  return { orders: o?.n ?? 0, products: p?.n ?? 0, categories: k?.n ?? 0, carts: c?.n ?? 0 };
}

/**
 * Deletes a shop and everything in it, orders included. The caller must type
 * the shop's exact name; it is checked again here. All or nothing.
 */
export async function deleteShopWithEverything(
  db: Database,
  shopId: string,
  confirmName: string,
): Promise<ShopContents> {
  const contents = await shopContents(db, shopId);
  await db.transaction(async (tx) => {
    const shop = await tx.query.shops.findFirst({ where: eq(shops.id, shopId) });
    if (!shop) throw ApiError.notFound('Shop not found');
    if (confirmName.trim() !== shop.name.trim()) {
      throw ApiError.badRequest('name_mismatch', 'The name does not match the shop name');
    }
    // Orders first: their lines point at products. The rest cascades.
    await tx.delete(orders).where(eq(orders.shopId, shopId));
    await tx.delete(shops).where(eq(shops.id, shopId));
  });
  return contents;
}

