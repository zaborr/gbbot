import type {
  AuthResponse,
  Cart,
  CatalogQuery,
  Category,
  CreateOrderResponse,
  ExportRequest,
  ExportResponse,
  Lang,
  Order,
  PlatformShopInput,
  Product,
  ProductInput,
  RetentionReport,
  RetentionSettings,
  RetentionStatus,
  SessionUser,
  ShopAdminView,
  ShopConfig,
  ShopProfileInput,
  ShippingZone,
  ShopSummary,
  PaymentSetup,
  ShopVipClub,
  CloneProductsRequest,
  CloneProductsResult,
  CloneSource,
  ClosePreview,
  UpdateVipClubRequest,
  VipClub,
  OrganizerShopInput,
  OrganizersView,
  OwnerSettingsInput,
  ShopTeam,
  ProductsCsvPreview,
  ProductsCsvResult,
  GbBackupPreview,
  ImportGbRequest,
  BroadcastAudience,
  BroadcastView,
  DisclaimerAdminView,
  WebAuthRequest,
  WebFile,
} from '@tma-shop/shared';
import { lang } from '../i18n/index.js';

export interface ShopsResponse {
  shops: ShopSummary[];
  isSuperAdmin: boolean;
  /** May create GBs of their own. */
  isOrganizer: boolean;
}

export interface ShopContents {
  orders: number;
  products: number;
  categories: number;
  carts: number;
}

export interface ProductPage {
  items: Product[];
  page: number;
  limit: number;
  total: number;
}

export interface CategoryInput {
  slug: string;
  title: string;
  sortOrder: number;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiClient {
  private token: string | null = null;
  private shop: string | null = null;
  private reauth: (() => Promise<string>) | null = null;
  private reauthing: Promise<string> | null = null;

  setToken(token: string | null): void {
    this.token = token;
  }

  /** How to get a fresh session when the current one expires (the app stays open for hours). */
  setReauth(reauth: (() => Promise<string>) | null): void {
    this.reauth = reauth;
  }

  private async refreshToken(): Promise<boolean> {
    if (!this.reauth) return false;
    // Several calls can expire at once: share one refresh.
    this.reauthing ??= this.reauth().finally(() => {
      this.reauthing = null;
    });
    try {
      this.token = await this.reauthing;
      return true;
    } catch {
      return false;
    }
  }

  /** Shop (id or slug) that shop-scoped calls — catalog, cart, orders, admin — apply to. */
  setShop(shop: string | null): void {
    this.shop = shop;
  }

  private async request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (this.shop) headers.set('X-Shop', this.shop);
    // Error messages come back in the user's language.
    headers.set('X-Lang', lang());

    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
    if (res.status === 401 && !retried && !path.startsWith('/auth') && (await this.refreshToken())) {
      return this.request<T>(path, init, true);
    }
    if (res.status === 204) return undefined as T;

    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiClientError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
    }
    return data as T;
  }

  // --- auth ---
  auth(initData: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth', {
      method: 'POST',
      body: JSON.stringify({ initData }),
    });
  }

  /** Web administrators: username, password and authenticator code (only through Tor). */
  webAuth(input: WebAuthRequest): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/web', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** Saves the app language for this user (null = follow Telegram). */
  setLanguage(language: Lang | null): Promise<SessionUser> {
    return this.request<SessionUser>('/me/language', {
      method: 'PUT',
      body: JSON.stringify({ language }),
    });
  }

  // --- shops & platform ---
  getShops(): Promise<ShopsResponse> {
    return this.request<ShopsResponse>('/shops');
  }

  platformGetShops(): Promise<ShopAdminView[]> {
    return this.request<ShopAdminView[]>('/platform/shops');
  }

  platformCreateShop(input: PlatformShopInput): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/platform/shops', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  platformUpdateShop(shopId: string, input: PlatformShopInput): Promise<ShopAdminView> {
    return this.request<ShopAdminView>(`/platform/shops/${shopId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /** One place up or down the start screen; returns the list in its new order. */
  platformMoveShop(shopId: string, direction: 'up' | 'down'): Promise<ShopAdminView[]> {
    return this.request<ShopAdminView[]>(`/platform/shops/${shopId}/move`, {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });
  }

  platformDeleteShop(shopId: string): Promise<void> {
    return this.request<void>(`/platform/shops/${shopId}`, { method: 'DELETE' });
  }

  /** How many orders, products, categories and carts a shop holds. */
  platformShopContents(shopId: string): Promise<ShopContents> {
    return this.request<ShopContents>(`/platform/shops/${shopId}/contents`);
  }

  /** Deletes a shop with everything in it; `confirmName` must be its exact name. */
  platformDeleteShopWithEverything(shopId: string, confirmName: string): Promise<ShopContents> {
    return this.request<ShopContents>(`/platform/shops/${shopId}/delete-all`, {
      method: 'POST',
      body: JSON.stringify({ confirmName }),
    });
  }

  /** Owner, admins (with names) and @usernames still to come. */
  platformGetTeam(shopId: string): Promise<ShopTeam> {
    return this.request<ShopTeam>(`/platform/shops/${shopId}/team`);
  }

  platformGetOrganizers(): Promise<OrganizersView> {
    return this.request<OrganizersView>('/platform/organizers');
  }

  platformUpdateOrganizers(people: string[], releaseShops = false): Promise<OrganizersView> {
    return this.request<OrganizersView>('/platform/organizers', {
      method: 'PUT',
      body: JSON.stringify({ people, releaseShops }),
    });
  }

  /** An organiser creates a GB of their own (it starts hidden). */
  organizerCreateShop(input: OrganizerShopInput): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/organizer/shops', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  platformGetRetention(): Promise<RetentionStatus> {
    return this.request<RetentionStatus>('/platform/retention');
  }

  platformUpdateRetention(settings: RetentionSettings): Promise<RetentionStatus> {
    return this.request<RetentionStatus>('/platform/retention', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  /** The platform-wide VIP club. */
  platformGetVipClub(): Promise<VipClub> {
    return this.request<VipClub>('/platform/vip-club');
  }

  platformUpdateVipClub(input: UpdateVipClubRequest): Promise<VipClub> {
    return this.request<VipClub>('/platform/vip-club', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  platformRunRetention(): Promise<RetentionReport> {
    return this.request<RetentionReport>('/platform/retention/run', { method: 'POST' });
  }

  // --- catalog ---
  getShop(): Promise<ShopConfig> {
    return this.request<ShopConfig>('/shop');
  }

  getCategories(): Promise<Category[]> {
    return this.request<Category[]>('/categories');
  }

  getProducts(query: Partial<CatalogQuery> = {}): Promise<ProductPage> {
    const params = new URLSearchParams();
    if (query.categoryId) params.set('categoryId', query.categoryId);
    if (query.search) params.set('search', query.search);
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return this.request<ProductPage>(`/products${qs ? `?${qs}` : ''}`);
  }

  getProduct(id: string): Promise<Product> {
    return this.request<Product>(`/products/${id}`);
  }

  // --- cart ---
  getCart(): Promise<Cart> {
    return this.request<Cart>('/cart');
  }

  /** `variantId` is required for products with options. */
  addToCart(productId: string, variantId: string | null, quantity: number): Promise<Cart> {
    return this.request<Cart>('/cart/items', {
      method: 'POST',
      body: JSON.stringify({ productId, variantId, quantity }),
    });
  }

  /** `lineId` is the cart line's `id`. */
  setCartItem(lineId: string, quantity: number): Promise<Cart> {
    return this.request<Cart>(`/cart/items/${lineId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity }),
    });
  }

  removeCartItem(lineId: string): Promise<Cart> {
    return this.request<Cart>(`/cart/items/${lineId}`, { method: 'DELETE' });
  }

  // --- orders & payment ---
  /**
   * Creates an order from the cart; `contactUsername` is the customer's Telegram @.
   * Shops with shipping also need the zone and the encrypted address.
   */
  createOrder(
    contactUsername: string,
    shipping: { shippingZoneId: string; encryptedAddress: string } | null = null,
  ): Promise<CreateOrderResponse> {
    return this.request<CreateOrderResponse>('/orders', {
      method: 'POST',
      body: JSON.stringify({ contactUsername, ...(shipping ?? {}) }),
    });
  }

  getOrders(): Promise<Order[]> {
    return this.request<Order[]>('/orders');
  }

  getOrder(id: string): Promise<Order> {
    return this.request<Order>(`/orders/${id}`);
  }

  /** Deletes one of the caller's orders (only unpaid or cancelled ones). */
  deleteOrder(orderId: string): Promise<void> {
    return this.request<void>(`/orders/${orderId}`, { method: 'DELETE' });
  }

  /** Reports a crypto payment (chosen wallet + tx hash) for manual verification. */
  submitPayment(orderId: string, methodId: string, txHash: string): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/payment`, {
      method: 'POST',
      body: JSON.stringify({ methodId, txHash }),
    });
  }

  /** Says the order was paid with a manual method (Wise, Bizum…); an admin checks it. */
  submitManualPayment(orderId: string, methodId: string, reference: string): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/manual-payment`, {
      method: 'POST',
      body: JSON.stringify({ methodId, reference }),
    });
  }

  /** Asks the shop to change a paid order to these lines (needs admin approval). */
  requestOrderChange(
    orderId: string,
    items: Array<{ productId: string; variantId: string | null; quantity: number }>,
  ): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/change`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  }

  withdrawOrderChange(orderId: string): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/change`, { method: 'DELETE' });
  }

  // --- admin ---
  /** Sets the fixed fee added once to each new order (0 = none) and its label. */
  adminGetShop(): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop');
  }

  /** The customer accepts the GB's conditions (the version shown). */
  acceptDisclaimer(version: number): Promise<void> {
    return this.request<void>('/shop/disclaimer/accept', {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
  }

  adminGetDisclaimer(): Promise<DisclaimerAdminView> {
    return this.request<DisclaimerAdminView>('/admin/shop/disclaimer');
  }

  /** Empty text removes it; `askAgain` makes everyone accept it again. */
  adminUpdateDisclaimer(text: string, askAgain: boolean): Promise<DisclaimerAdminView> {
    return this.request<DisclaimerAdminView>('/admin/shop/disclaimer', {
      method: 'PUT',
      body: JSON.stringify({ text, askAgain }),
    });
  }

  /**
   * Less private: the bot sends the shipping list (decrypted on this device)
   * to the admin's chat; it passes through the server without being kept and
   * the bot deletes it from the chat after 24 hours.
   */
  adminSendShippingList(fileName: string, csv: string, count: number): Promise<{ sent: boolean }> {
    return this.request('/admin/shipping-list/send', {
      method: 'POST',
      body: JSON.stringify({ fileName, csv, count }),
    });
  }

  /** How many buyers a message to `audience` would reach. */
  adminBroadcastCount(audience: BroadcastAudience): Promise<{ count: number }> {
    return this.request(`/admin/broadcasts/count?audience=${audience}`);
  }

  adminListBroadcasts(): Promise<BroadcastView[]> {
    return this.request<BroadcastView[]>('/admin/broadcasts');
  }

  /** Sends a message to the GB's buyers through the bot (in the background). */
  adminSendBroadcast(audience: BroadcastAudience, text: string): Promise<BroadcastView> {
    return this.request<BroadcastView>('/admin/broadcasts', {
      method: 'POST',
      body: JSON.stringify({ audience, text }),
    });
  }

  /** Owner only: who runs the GB. */
  adminGetTeam(): Promise<ShopTeam> {
    return this.request<ShopTeam>('/admin/shop/team');
  }

  /** Owner only: admins and visibility. */
  adminUpdateOwnerSettings(input: OwnerSettingsInput): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/owner', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /** Owner only: a new hidden GB with the same settings and catalog (no orders). */
  adminDuplicateShop(name: string, slug: string): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/duplicate', {
      method: 'POST',
      body: JSON.stringify({ name, slug }),
    });
  }

  /** Owner only: the bot sends a JSON backup of the GB (settings and catalog). */
  adminBackupShop(): Promise<{ fileName: string; products: number; file?: WebFile }> {
    return this.request('/admin/shop/backup', { method: 'POST' });
  }

  /** A file the user sent to the bot, to import it here. */
  getUpload(
    id: string,
  ): Promise<{ kind: 'csv' | 'backup'; fileName: string; content: string; shopSlug: string | null }> {
    return this.request(`/uploads/${id}`);
  }

  /** Forgets a file sent to the bot once it has been imported. */
  deleteUpload(id: string): Promise<void> {
    return this.request<void>(`/uploads/${id}`, { method: 'DELETE' });
  }

  /** What a backup file holds (nothing is saved). */
  organizerPreviewBackup(backup: unknown): Promise<GbBackupPreview> {
    return this.request<GbBackupPreview>('/organizer/shops/import/preview', {
      method: 'POST',
      body: JSON.stringify({ backup }),
    });
  }

  /** Imports a backup as a new hidden GB, owned by the caller. */
  organizerImportBackup(input: Omit<ImportGbRequest, 'backup'> & { backup: unknown }): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/organizer/shops/import', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  adminShopContents(): Promise<ShopContents> {
    return this.request<ShopContents>('/admin/shop/contents');
  }

  /** Owner only: deletes the GB with everything in it; `confirmName` must be its exact name. */
  adminDeleteShopWithEverything(confirmName: string): Promise<ShopContents> {
    return this.request<ShopContents>('/admin/shop/delete-all', {
      method: 'POST',
      body: JSON.stringify({ confirmName }),
    });
  }

  /** What closing the GB now would do. */
  adminClosePreview(): Promise<ClosePreview> {
    return this.request<ClosePreview>('/admin/shop/close-preview');
  }

  adminCloseShop(): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/close', { method: 'POST' });
  }

  adminReopenShop(): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/reopen', { method: 'POST' });
  }

  /** Schedules (ISO date) or, with null, cancels the closing of the GB. */
  /** The GB's minimum to go ahead (null = none) and whether customers see amounts. */
  adminUpdateGoal(amount: number | null, showAmount: boolean): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/goal', {
      method: 'PUT',
      body: JSON.stringify({ amount, showAmount }),
    });
  }

  adminScheduleClosing(closesAt: string | null, warnHours?: number): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/closing', {
      method: 'PUT',
      body: JSON.stringify(warnHours === undefined ? { closesAt } : { closesAt, warnHours }),
    });
  }

  /** Other shops the user manages, to copy products from. */
  adminGetCloneSources(): Promise<CloneSource[]> {
    return this.request<CloneSource[]>('/admin/clone-sources');
  }

  adminCloneProducts(input: CloneProductsRequest): Promise<CloneProductsResult> {
    return this.request<CloneProductsResult>('/admin/clone', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** The shop's own VIP club. */
  adminGetVipClub(): Promise<ShopVipClub> {
    return this.request<ShopVipClub>('/admin/shop/vip-club');
  }

  adminUpdateVipClub(input: UpdateVipClubRequest): Promise<ShopVipClub> {
    return this.request<ShopVipClub>('/admin/shop/vip-club', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  adminUpdateProfile(input: ShopProfileInput): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/profile', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /** Receiving addresses and accepted networks/tokens of the shop. */
  adminUpdatePayments(setup: PaymentSetup): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/payments', {
      method: 'PUT',
      body: JSON.stringify(setup),
    });
  }

  adminUpdateShipping(
    zones: Array<Omit<ShippingZone, 'id'> & { id?: string }>,
    vipNoShipping: boolean,
  ): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/shipping', {
      method: 'PUT',
      body: JSON.stringify({ zones, vipNoShipping }),
    });
  }

  /** Sets the shop's address public key (base64 SPKI), or removes it with null. */
  adminUpdateAddressKey(publicKey: string | null): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/address-key', {
      method: 'PUT',
      body: JSON.stringify({ publicKey }),
    });
  }

  /** Hours without activity before an unpaid order is cancelled (0 = never). */
  adminUpdateAutoCancel(hours: number): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/auto-cancel', {
      method: 'PUT',
      body: JSON.stringify({ hours }),
    });
  }

  adminUpdateOrderFee(
    orderFee: number,
    orderFeeLabel: string,
    vipNoFee?: boolean,
  ): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/fee', {
      method: 'PUT',
      body: JSON.stringify({ orderFee, orderFeeLabel, vipNoFee }),
    });
  }

  adminApproveChange(orderId: string): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}/change/approve`, { method: 'POST' });
  }

  adminRejectChange(orderId: string): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}/change/reject`, { method: 'POST' });
  }

  /** Records that the overpaid difference was sent back to the customer. */
  /** Checks the order's submitted transaction on the blockchain again. */
  adminRecheckPayment(orderId: string): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}/recheck`, { method: 'POST' });
  }

  adminRecordRefund(orderId: string): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}/refund`, { method: 'POST' });
  }

  adminGetOrders(): Promise<Order[]> {
    return this.request<Order[]>('/admin/orders');
  }

  adminCreateCategory(input: CategoryInput): Promise<Category> {
    return this.request<Category>('/admin/categories', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  adminUpdateCategory(categoryId: string, input: CategoryInput): Promise<Category> {
    return this.request<Category>(`/admin/categories/${categoryId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /** Deletes a category; its products stay, without a category. */
  adminDeleteCategory(categoryId: string): Promise<void> {
    return this.request<void>(`/admin/categories/${categoryId}`, { method: 'DELETE' });
  }

  /** The bot sends the report file to the admin's own Telegram chat. */
  adminExport(request: ExportRequest): Promise<ExportResponse> {
    return this.request<ExportResponse>('/admin/export', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  adminGetOrder(orderId: string): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}`);
  }

  adminDeleteOrder(orderId: string): Promise<void> {
    return this.request<void>(`/admin/orders/${orderId}`, { method: 'DELETE' });
  }

  /** All products, hidden ones included. */
  adminGetProducts(): Promise<Product[]> {
    return this.request<Product[]>('/admin/products');
  }

  /** The bot sends the catalog as CSV to the admin's chat. */
  adminExportProductsCsv(): Promise<{ fileName: string; products: number; file?: WebFile }> {
    return this.request('/admin/products/csv/export', { method: 'POST' });
  }

  /** What importing this CSV would do (nothing is saved). */
  adminPreviewProductsCsv(csv: string): Promise<ProductsCsvPreview> {
    return this.request<ProductsCsvPreview>('/admin/products/csv/preview', {
      method: 'POST',
      body: JSON.stringify({ csv }),
    });
  }

  adminImportProductsCsv(csv: string): Promise<ProductsCsvResult> {
    return this.request<ProductsCsvResult>('/admin/products/csv/import', {
      method: 'POST',
      body: JSON.stringify({ csv }),
    });
  }

  adminUpdateProduct(productId: string, input: ProductInput): Promise<Product> {
    return this.request<Product>(`/admin/products/${productId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /** Moves an order to another status; the bot tells the customer (with the note, if any). */
  adminSetOrderStatus(
    orderId: string,
    status: Order['status'],
    extra: { note?: string; trackingNumber?: string; force?: boolean } = {},
  ): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...extra }),
    });
  }

  /** Deletes a product, or archives it when it already appears in an order. */
  /** Administrators: every product at once; `confirmCount` = how many were shown. */
  adminDeleteAllProducts(confirmCount: number): Promise<{ deleted: number; archived: number }> {
    return this.request<{ deleted: number; archived: number }>('/admin/products/delete-all', {
      method: 'POST',
      body: JSON.stringify({ confirmCount }),
    });
  }

  adminDeleteProduct(productId: string): Promise<void> {
    return this.request<void>(`/admin/products/${productId}`, { method: 'DELETE' });
  }

  adminCreateProduct(input: ProductInput): Promise<Product> {
    return this.request<Product>('/admin/products', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}

export const api = new ApiClient();
