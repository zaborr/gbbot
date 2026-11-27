import type {
  ReducePreview,
  AddCreatorAccountRequest,
  BotInfo,
  BotSettings,
  BotsOverview,
  CreatorAccountInfo,
  CreatorLoginStep,
  UpdateBotSettingsRequest,
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
  SupervisorsView,
  OwnerSettingsInput,
  ShopTeam,
  ProductsCsvPreview,
  ProductsCsvResult,
  GbBackupPreview,
  ImportGbRequest,
  BroadcastAudience,
  BuyerDetail,
  BuyerSummary,
  ReachResult,
  BroadcastView,
  DisclaimerAdminView,
  WebAuthRequest,
  WebFile,
  WebNotice,
  BlacklistCheck,
  BlacklistView,
  WebAccessStatus,
  WebAccountView,
  WebCredentials,
  WebRole,
  CheckoutFields,
  CreateTestingRequest,
  Testing,
  TestingReportView,
  LabProgressRequest,
  Lab,
  LabRequest,
  PendingRefund,
  TestingNotJoined,
  TestingParticipant,
  UpdateTestingRequest,
} from '@tma-shop/shared';
import { lang } from '../i18n/index.js';

/** Proof of a finished "Log in with Telegram" (the server keeps who it was). */
export type TelegramAuth = string;

export interface ShopsResponse {
  shops: ShopSummary[];
  isSuperAdmin: boolean;
  /** May create GBs of their own. */
  isOrganizer: boolean;
  /** Manages something, so may activate web access. */
  canUseWeb?: boolean;
  /** Show "how it works" (first visit only). */
  showHowTo?: boolean;
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

/** Where lab reports are listed: one's own, a GB's (admin), or every GB's (platform). */
export type ReportScope = 'mine' | 'admin' | 'platform';
const REPORT_BASE: Record<ReportScope, string> = {
  mine: '/products/testing-reports',
  admin: '/admin/testing-reports',
  platform: '/platform/testing-reports',
};

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
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
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

  /** A file from the API (a lab report), with the same credentials. */
  private async requestBlob(path: string, retried = false): Promise<Blob> {
    const headers = new Headers();
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (this.shop) headers.set('X-Shop', this.shop);
    headers.set('X-Lang', lang());
    const res = await fetch(`${BASE_URL}${path}`, { headers });
    if (res.status === 401 && !retried && (await this.refreshToken())) return this.requestBlob(path, true);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiClientError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? res.statusText);
    }
    return res.blob();
  }

  // --- lab reports kept: `mine` (taking part), `admin` (this GB), `platform` (every GB) ---
  testingReports(scope: ReportScope): Promise<TestingReportView[]> {
    return this.request<TestingReportView[]>(`${REPORT_BASE[scope]}`);
  }

  testingReportFile(scope: ReportScope, id: string): Promise<Blob> {
    return this.requestBlob(`${REPORT_BASE[scope]}/${id}/file`);
  }

  sendTestingReport(scope: ReportScope, id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`${REPORT_BASE[scope]}/${id}/send`, { method: 'POST' });
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

  // --- web accounts (panel of full platform accounts) ---
  webAccounts(): Promise<WebAccountView[]> {
    return this.request<WebAccountView[]>('/web-accounts');
  }

  createWebAccount(username: string, role: WebRole, telegramId?: number): Promise<WebCredentials> {
    return this.request<WebCredentials>('/web-accounts', {
      method: 'POST',
      body: JSON.stringify({ username, role, telegramId }),
    });
  }

  resetWebAccount(id: number): Promise<WebCredentials> {
    return this.request<WebCredentials>(`/web-accounts/${id}/reset`, { method: 'POST' });
  }

  setWebAccountRole(id: number, role: WebRole): Promise<void> {
    return this.request<void>(`/web-accounts/${id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
  }

  deleteWebAccount(id: number): Promise<void> {
    return this.request<void>(`/web-accounts/${id}`, { method: 'DELETE' });
  }

  /** The signed-in web account's password; returns the session that replaces this one. */
  changeWebPassword(current: string, next: string): Promise<{ token: string; expiresAt: string }> {
    return this.request('/web-accounts/me/password', {
      method: 'POST',
      body: JSON.stringify({ current, next }),
    });
  }

  // --- web access (activated from Telegram) ---
  getWebAccess(): Promise<WebAccessStatus> {
    return this.request<WebAccessStatus>('/me/web-access');
  }

  createWebAccess(username: string): Promise<WebCredentials> {
    return this.request<WebCredentials>('/me/web-access', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  }

  resetWebAccess(): Promise<WebCredentials> {
    return this.request<WebCredentials>('/me/web-access/reset', { method: 'POST' });
  }

  deleteWebAccess(): Promise<void> {
    return this.request<void>('/me/web-access', { method: 'DELETE' });
  }

  /** Saves the app language for this user (null = follow Telegram). */
  setLanguage(language: Lang | null): Promise<SessionUser> {
    return this.request<SessionUser>('/me/language', {
      method: 'PUT',
      body: JSON.stringify({ language }),
    });
  }

  getSecurityPhrase(): Promise<{ phrase: string | null }> {
    return this.request<{ phrase: string | null }>('/me/security-phrase');
  }

  setSecurityPhrase(phrase: string): Promise<{ phrase: string }> {
    return this.request<{ phrase: string }>('/me/security-phrase', { method: 'PUT', body: JSON.stringify({ phrase }) });
  }

  /** Closed "how it works": not shown again on any device. */
  markHowToSeen(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/me/how-to-seen', { method: 'POST' });
  }

  // --- shops & platform ---
  getShops(): Promise<ShopsResponse> {
    return this.request<ShopsResponse>('/shops');
  }

  /** Web administrators: their inbox (newest first). */
  platformNotices(): Promise<{ notices: WebNotice[]; unread: number }> {
    return this.request('/platform/notices');
  }

  platformUnreadNotices(): Promise<{ unread: number }> {
    return this.request('/platform/notices/unread');
  }

  platformNoticesSeen(upTo: number): Promise<void> {
    return this.request<void>('/platform/notices/seen', {
      method: 'POST',
      body: JSON.stringify({ upTo }),
    });
  }

  /** Full platform accounts: one notice out of the shared inbox, or all of them. */
  platformDeleteNotice(id: number): Promise<void> {
    return this.request<void>(`/platform/notices/${id}`, { method: 'DELETE' });
  }

  platformDeleteNotices(): Promise<void> {
    return this.request<void>('/platform/notices', { method: 'DELETE' });
  }

  // --- blacklists: of the GB (its administrators) and of the platform ---
  adminBlacklist(): Promise<BlacklistView> {
    return this.request<BlacklistView>('/admin/blacklist');
  }

  adminBlacklistCheck(who: string): Promise<BlacklistCheck> {
    return this.request<BlacklistCheck>('/admin/blacklist/check', {
      method: 'POST',
      body: JSON.stringify({ who }),
    });
  }

  adminBlacklistAdd(
    who: string,
    removeData: boolean,
    reason: string,
    scope: 'shop' | 'platform',
  ): Promise<BlacklistView> {
    return this.request<BlacklistView>('/admin/blacklist', {
      method: 'POST',
      body: JSON.stringify({ who, removeData, reason, scope }),
    });
  }

  adminBlacklistRemove(who: string): Promise<BlacklistView> {
    return this.request<BlacklistView>('/admin/blacklist/remove', {
      method: 'POST',
      body: JSON.stringify({ who }),
    });
  }

  platformBlacklist(): Promise<BlacklistView> {
    return this.request<BlacklistView>('/platform/blacklist');
  }

  platformBlacklistCheck(who: string): Promise<BlacklistCheck> {
    return this.request<BlacklistCheck>('/platform/blacklist/check', {
      method: 'POST',
      body: JSON.stringify({ who }),
    });
  }

  platformBlacklistAdd(who: string, removeData: boolean, reason: string): Promise<BlacklistView> {
    return this.request<BlacklistView>('/platform/blacklist', {
      method: 'POST',
      body: JSON.stringify({ who, removeData, reason }),
    });
  }

  platformBlacklistRemove(who: string): Promise<BlacklistView> {
    return this.request<BlacklistView>('/platform/blacklist/remove', {
      method: 'POST',
      body: JSON.stringify({ who }),
    });
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

  platformGetSupervisors(): Promise<SupervisorsView> {
    return this.request<SupervisorsView>('/platform/supervisors');
  }

  platformUpdateSupervisors(people: string[]): Promise<SupervisorsView> {
    return this.request<SupervisorsView>('/platform/supervisors', {
      method: 'PUT',
      body: JSON.stringify({ people }),
    });
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

  /** The bot the platform answers as now (public). */
  getActiveBot(): Promise<{ username: string | null }> {
    return this.request<{ username: string | null }>('/bot');
  }

  platformClearBotHistory(): Promise<{ ok: true }> {
    return this.request<{ ok: true }>('/platform/bots/history', { method: 'DELETE' });
  }

  platformRetryBotGroups(): Promise<{ ok: number; failed: number }> {
    return this.request<{ ok: number; failed: number }>('/platform/bots/groups', { method: 'POST' });
  }

  platformGetBots(): Promise<BotsOverview> {
    return this.request<BotsOverview>('/platform/bots');
  }

  platformSetMenuButton(): Promise<{ menuUrl: string }> {
    return this.request<{ menuUrl: string }>('/platform/bots/menu', { method: 'POST' });
  }

  platformSwitchBot(token: string): Promise<BotInfo> {
    return this.request<BotInfo>('/platform/bots/switch', { method: 'POST', body: JSON.stringify({ token }) });
  }

  platformBotSettings(): Promise<BotSettings> {
    return this.request<BotSettings>('/platform/bots/settings');
  }

  platformUpdateBotSettings(input: UpdateBotSettingsRequest): Promise<BotSettings> {
    return this.request<BotSettings>('/platform/bots/settings', { method: 'PUT', body: JSON.stringify(input) });
  }

  platformCreateReserve(): Promise<BotInfo> {
    return this.request<BotInfo>('/platform/bots/reserve', { method: 'POST' });
  }

  platformUseReserve(id: number): Promise<BotInfo> {
    return this.request<BotInfo>(`/platform/bots/${id}/use`, { method: 'POST' });
  }

  platformRetireBot(id: number): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(`/platform/bots/${id}`, { method: 'DELETE' });
  }

  platformCreatorAccounts(): Promise<CreatorAccountInfo[]> {
    return this.request<CreatorAccountInfo[]>('/platform/creator-accounts');
  }

  platformAddCreatorAccount(input: AddCreatorAccountRequest): Promise<CreatorLoginStep> {
    return this.request<CreatorLoginStep>('/platform/creator-accounts', { method: 'POST', body: JSON.stringify(input) });
  }

  platformCreatorRelogin(id: number): Promise<CreatorLoginStep> {
    return this.request<CreatorLoginStep>(`/platform/creator-accounts/${id}/relogin`, { method: 'POST' });
  }

  platformCreatorCode(id: number, code: string): Promise<CreatorLoginStep> {
    return this.request<CreatorLoginStep>(`/platform/creator-accounts/${id}/code`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  platformCreatorPassword(id: number, password: string): Promise<CreatorLoginStep> {
    return this.request<CreatorLoginStep>(`/platform/creator-accounts/${id}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  platformRemoveCreatorAccount(id: number): Promise<{ ok: true }> {
    return this.request<{ ok: true }>(`/platform/creator-accounts/${id}`, { method: 'DELETE' });
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

  /** The platform-wide guests. */
  platformGetGuests(): Promise<VipClub> {
    return this.request<VipClub>('/platform/guests');
  }

  platformUpdateGuests(input: UpdateVipClubRequest): Promise<VipClub> {
    return this.request<VipClub>('/platform/guests', {
      method: 'PUT',
      body: JSON.stringify(input),
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
    if (query.testing) params.set('testing', query.testing);
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

  /** Joins a product testing with this cart (or changes the vial offer). */
  joinTesting(testingId: string, volunteer: boolean, extra?: number): Promise<Cart> {
    return this.request<Cart>('/cart/testings', {
      method: 'POST',
      body: JSON.stringify({ testingId, volunteer, ...(extra !== undefined ? { extra } : {}) }),
    });
  }

  leaveTesting(testingId: string): Promise<Cart> {
    return this.request<Cart>(`/cart/testings/${testingId}`, { method: 'DELETE' });
  }

  /** Gives to a testing once the GB is closed (whole units): the order then waits for that payment. */
  addDonation(orderId: string, testingId: string, amount: number): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/donations`, {
      method: 'POST',
      body: JSON.stringify({ testingId, amount }),
    });
  }

  /** Takes back what was given to a testing, while it is not paid. */
  removeDonation(orderId: string, testingId: string): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/donations/${testingId}`, { method: 'DELETE' });
  }

  /** Joins a product testing with an order already placed (paid or not). */
  addOrderTesting(orderId: string, testingId: string, volunteer: boolean): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/testings`, {
      method: 'POST',
      body: JSON.stringify({ testingId, volunteer }),
    });
  }

  /** Offering a vial in one testing (or not), until its draw. */
  setTestingVolunteer(orderId: string, testingId: string, volunteer: boolean): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/orders/${orderId}/testings/${testingId}/volunteer`, {
      method: 'PUT',
      body: JSON.stringify({ volunteer }),
    });
  }

  /** Joins a testing from outside (bought elsewhere): an order of only the fee. */
  joinExternalTesting(testingId: string, volunteer: boolean, contactUsername: string | null): Promise<CreateOrderResponse> {
    return this.request<CreateOrderResponse>(`/orders/external-testing/${testingId}`, {
      method: 'POST',
      body: JSON.stringify({ volunteer, contactUsername }),
    });
  }

  /** The GB's product testings (for the catalog). */
  getTestings(): Promise<Testing[]> {
    return this.request<Testing[]>('/products/testings');
  }

  /** Why the draw cannot be launched yet (`gb_open`, `not_closed`, `unpaid`), or null. */
  adminGetDrawStatus(id: string): Promise<{ blocker: string | null }> {
    return this.request<{ blocker: string | null }>(`/admin/testings/${id}/draw`);
  }

  adminLaunchDraw(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/draw`, { method: 'POST' });
  }

  adminSubstituteDonor(id: string, ref: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/substitute`, {
      method: 'POST',
      body: JSON.stringify({ ref }),
    });
  }

  /** Closes a drawn testing: donors get their vial's price back. */
  adminAddTestingParticipant(
    id: string,
    input: { who: string; amount: number | null; volunteer: boolean; notify: boolean },
  ): Promise<{ orderId: string | null; notified: boolean; invited: boolean }> {
    return this.request<{ orderId: string | null; notified: boolean; invited: boolean }>(
      `/admin/testings/${id}/participants`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  adminRemoveTestingInvite(id: string, who: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/invites/${encodeURIComponent(who)}`, { method: 'DELETE' });
  }

  adminGetTestingNotJoined(id: string): Promise<TestingNotJoined[]> {
    return this.request<TestingNotJoined[]>(`/admin/testings/${id}/not-joined`);
  }

  adminInviteTestingBuyers(id: string): Promise<{ sent: number }> {
    return this.request<{ sent: number }>(`/admin/testings/${id}/invite-buyers`, { method: 'POST' });
  }

  adminRemindTestingUnpaid(id: string): Promise<{ sent: number }> {
    return this.request<{ sent: number }>(`/admin/testings/${id}/remind`, { method: 'POST' });
  }

  adminSettleTesting(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/settle`, { method: 'POST' });
  }

  // --- the GB's labs and their tests with prices ---
  adminLabs(): Promise<Lab[]> {
    return this.request<Lab[]>('/admin/labs');
  }

  adminSaveLab(id: string | null, input: LabRequest): Promise<Lab> {
    return this.request<Lab>(id ? `/admin/labs/${id}` : '/admin/labs', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(input),
    });
  }

  adminDeleteLab(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/labs/${id}`, { method: 'DELETE' });
  }

  /** After the draw: vials sent to the lab, received there, or the day results are expected. */
  adminTestingLab(id: string, step: LabProgressRequest): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/lab`, { method: 'POST', body: JSON.stringify(step) });
  }

  /** The open time to join and give ends some hours from now, or now (0). */
  adminMoveTestingWindow(id: string, hours: number): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/window`, {
      method: 'POST',
      body: JSON.stringify({ hours }),
    });
  }

  /** The time to join and give opens again (closed, or settled with nothing reached). */
  /** A customer on the web: the key an organiser gave them. */
  webKeyAuth(key: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/key', { method: 'POST', body: JSON.stringify({ key }) });
  }

  webBanner(): Promise<{ text: string | null }> {
    return this.request<{ text: string | null }>('/web/banner');
  }

  myNotices(): Promise<Array<{ id: string; text: string; at: string }>> {
    return this.request('/me/notices');
  }

  platformSetWebBanner(text: string | null): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/platform/web-banner', { method: 'PUT', body: JSON.stringify({ text }) });
  }

  platformWebBanner(): Promise<{ text: string | null }> {
    return this.request<{ text: string | null }>('/platform/web-banner');
  }

  adminWebKey(
    userId: number,
  ): Promise<{ key: { createdAt: string; expiresAt: string; lastUsedAt: string | null } | null; canVipEverywhere: boolean }> {
    return this.request(`/admin/web-keys/${userId}`);
  }

  adminGiveWebKey(userId: number, vip: 'none' | 'shop' | 'platform'): Promise<{ key: string; expiresAt: string; url: string; more: string[] }> {
    return this.request('/admin/web-keys', { method: 'POST', body: JSON.stringify({ userId, vip }) });
  }

  adminRevokeWebKey(userId: number): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/web-keys/${userId}`, { method: 'DELETE' });
  }

  adminFindCustomer(username: string): Promise<{ telegramId: number; username: string | null; firstName: string }[]> {
    return this.request(`/admin/customers/lookup?username=${encodeURIComponent(username)}`);
  }

  adminAddCustomer(input: { telegramId: number; username: string | null; firstName: string }): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/admin/customers', { method: 'POST', body: JSON.stringify(input) });
  }

  // --- Customers' web accounts ---------------------------------------------------

  webConfig(): Promise<{ telegramLogin: boolean }> {
    return this.request('/web/config');
  }

  telegramLoginStart(): Promise<{ url: string; state: string }> {
    return this.request('/auth/telegram/start', { method: 'POST' });
  }

  telegramLoginResult(state: string): Promise<{ status: 'waiting' | 'ready' | 'failed' }> {
    return this.request('/web/telegram/result', { method: 'POST', body: JSON.stringify({ state }) });
  }

  inviteInfo(code: string): Promise<{ kind: 'group' | 'personal'; name: string | null }> {
    return this.request('/auth/invite', { method: 'POST', body: JSON.stringify({ code }) });
  }

  signUp(input: { code: string; username: string; password: string; telegram?: TelegramAuth }): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/signup', { method: 'POST', body: JSON.stringify(input) });
  }

  accountLogin(username: string, password: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  }

  telegramLogin(telegram: TelegramAuth): Promise<AuthResponse> {
    return this.request<AuthResponse>('/auth/telegram', { method: 'POST', body: JSON.stringify({ telegram }) });
  }

  myAccount(): Promise<{ account: { username: string; linkState: 'confirmed' | 'staff' } | null }> {
    return this.request('/me/account');
  }

  createMyAccount(input: { username: string; password: string; telegram?: TelegramAuth }): Promise<{
    username: string;
    linkState: 'confirmed' | 'staff';
    token: string;
    expiresAt: string;
  }> {
    return this.request('/me/account', { method: 'POST', body: JSON.stringify(input) });
  }

  changeMyPassword(input: { password: string; current?: string; telegram?: TelegramAuth }): Promise<{ token: string; expiresAt: string }> {
    return this.request('/me/account/password', { method: 'PUT', body: JSON.stringify(input) });
  }

  confirmMyAccount(telegram: TelegramAuth): Promise<{ linkState: 'confirmed' }> {
    return this.request('/me/account/confirm', { method: 'POST', body: JSON.stringify({ telegram }) });
  }

  adminCreateInvite(input: {
    kind: 'group' | 'personal';
    days?: number;
    userId?: number;
    vip?: 'none' | 'shop' | 'platform';
  }): Promise<{ id: string; code: string; expiresAt: string; url: string; more: string[] }> {
    return this.request('/admin/invites', { method: 'POST', body: JSON.stringify(input) });
  }

  adminInvites(): Promise<
    Array<{
      id: string;
      kind: 'group' | 'personal';
      forWhom: string | null;
      vip: string;
      createdBy: string;
      createdAt: string;
      expiresAt: string;
      revoked: boolean;
      uses: number;
    }>
  > {
    return this.request('/admin/invites');
  }

  adminRevokeInvite(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/invites/${id}`, { method: 'DELETE' });
  }

  adminAccount(userId: number): Promise<{
    account: { username: string; linkState: 'confirmed' | 'staff'; linkedBy: string | null; manages: boolean } | null;
    canReset: boolean;
  }> {
    return this.request(`/admin/accounts/${userId}`);
  }

  adminResetAccount(userId: number): Promise<{ username: string; password: string }> {
    return this.request(`/admin/accounts/${userId}/reset`, { method: 'POST' });
  }

  adminCreateOrder(input: {
    who: string;
    items: Array<{ productId: string; variantId: string | null; quantity: number; unitPrice: number | null }>;
    shippingZoneId: string | null;
    paid: boolean;
    notify: boolean;
  }): Promise<{ order: Order | null; notified: boolean; pending: boolean }> {
    return this.request<{ order: Order | null; notified: boolean; pending: boolean }>('/admin/orders/create', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  adminPendingOrders(): Promise<Array<{ id: string; who: string; createdAt: string; request: { items: Array<{ quantity: number }> } }>> {
    return this.request('/admin/orders/pending');
  }

  adminRemovePendingOrder(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/orders/pending/${id}`, { method: 'DELETE' });
  }

  setOrderAddress(orderId: string, encryptedAddress: string): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/address`, {
      method: 'POST',
      body: JSON.stringify({ encryptedAddress }),
    });
  }

  /** The shipping label the organisers asked for: the file as it is. */
  uploadOrderLabel(orderId: string, file: File): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/orders/${orderId}/label`, {
      method: 'POST',
      headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });
  }

  adminRequestLabel(orderId: string, note: string | null): Promise<{ sent: boolean }> {
    return this.request<{ sent: boolean }>(`/admin/orders/${orderId}/label-request`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  }

  adminRequestLabels(input: { zone: string | null; note: string | null; dryRun: boolean }): Promise<{ count: number; sent: number }> {
    return this.request<{ count: number; sent: number }>('/admin/orders/label-requests', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  adminLabelFile(orderId: string): Promise<Blob> {
    return this.requestBlob(`/admin/orders/${orderId}/label`);
  }

  adminSendLabel(orderId: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/orders/${orderId}/label/send`, { method: 'POST' });
  }

  /** An image (already made smaller) kept on the server: its link back. */
  adminUploadImage(image: Blob): Promise<{ url: string }> {
    return this.request<{ url: string }>('/admin/images', {
      method: 'POST',
      headers: { 'Content-Type': image.type },
      body: image,
    });
  }

  adminOpenTestingExtra(id: string, input: { hours: number; mode: 'cap' | 'all'; tiers: number }): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/extra`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  adminRemindExtra(id: string): Promise<{ sent: number }> {
    return this.request<{ sent: number }>(`/admin/testings/${id}/extra/remind`, { method: 'POST' });
  }

  adminCloseExtraPay(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/extra/close`, { method: 'POST' });
  }

  adminDecideExtra(id: string, choice: 'round' | 'cover' | 'continue'): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/extra/decide`, {
      method: 'POST',
      body: JSON.stringify({ choice }),
    });
  }

  adminReopenTesting(id: string, hours: number): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ hours }),
    });
  }

  adminCancelTesting(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}/cancel`, { method: 'POST' });
  }

  /** The bot asks this organiser for the lab report (they reply with the file). */
  /** Signs up to a testing's extra round from an order, with a cap (or changes it). */
  signUpExtra(orderId: string, testingId: string, cap: number): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/extra`, { method: 'POST', body: JSON.stringify({ testingId, cap }) });
  }

  leaveExtra(orderId: string, testingId: string): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/extra/${testingId}`, { method: 'DELETE' });
  }

  /** The second round of the extra one: going on (paying the difference) or leaving (all back). */
  answerExtraRound(orderId: string, testingId: string, stay: boolean): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/extra/round`, {
      method: 'POST',
      body: JSON.stringify({ testingId, stay }),
    });
  }

  adminRequestTestingReport(id: string, kind: 'base' | 'extra' = 'base'): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `/admin/testings/${id}/report-request${kind === 'extra' ? '?kind=extra' : ''}`,
      { method: 'POST' },
    );
  }

  adminGetTestingParticipants(id: string): Promise<TestingParticipant[]> {
    return this.request<TestingParticipant[]>(`/admin/testings/${id}/participants`);
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
    contactUsername: string | null,
    details: { shippingZoneId?: string; encryptedAddress: string } | null = null,
  ): Promise<CreateOrderResponse> {
    return this.request<CreateOrderResponse>('/orders', {
      method: 'POST',
      body: JSON.stringify({ ...(contactUsername ? { contactUsername } : {}), ...(details ?? {}) }),
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
  /** Adds details (encrypted here) to the customer's own order. */
  addOrderDetails(orderId: string, encrypted: string): Promise<Order> {
    return this.request<Order>(`/orders/${orderId}/details`, {
      method: 'POST',
      body: JSON.stringify({ encrypted }),
    });
  }

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
  adminBroadcastCount(audience: BroadcastAudience, testingId: string | null = null): Promise<{ count: number }> {
    return this.request(
      `/admin/broadcasts/count?audience=${audience}${testingId ? `&testingId=${testingId}` : ''}`,
    );
  }

  adminGetBuyers(): Promise<BuyerSummary[]> {
    return this.request<BuyerSummary[]>('/admin/buyers');
  }

  adminGetBuyer(userId: number): Promise<BuyerDetail> {
    return this.request<BuyerDetail>(`/admin/buyers/${userId}`);
  }

  adminBuyerReach(userId: number): Promise<{ reachable: boolean }> {
    return this.request<{ reachable: boolean }>(`/admin/buyers/${userId}/reach`, { method: 'POST' });
  }

  adminMessageBuyer(userId: number, text: string): Promise<{ sent: boolean }> {
    return this.request<{ sent: boolean }>(`/admin/buyers/${userId}/message`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  adminListBroadcasts(): Promise<BroadcastView[]> {
    return this.request<BroadcastView[]>('/admin/broadcasts');
  }

  adminReachStatus(id: string): Promise<ReachResult> {
    return this.request<ReachResult>(`/admin/broadcasts/reach/${id}`);
  }

  adminCheckReach(audience: BroadcastAudience, testingId: string | null): Promise<{ id: string; checking: number }> {
    return this.request<{ id: string; checking: number }>('/admin/broadcasts/reach', {
      method: 'POST',
      body: JSON.stringify({ audience, testingId }),
    });
  }

  /** Sends a message to the GB's buyers through the bot (in the background). */
  adminSendBroadcast(audience: BroadcastAudience, text: string, testingId: string | null = null): Promise<BroadcastView> {
    return this.request<BroadcastView>('/admin/broadcasts', {
      method: 'POST',
      body: JSON.stringify({ audience, text, testingId }),
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

  /** The shop's guests (same shape as a VIP club). */
  adminGetGuests(): Promise<ShopVipClub> {
    return this.request<ShopVipClub>('/admin/shop/guests');
  }

  adminUpdateGuests(input: UpdateVipClubRequest): Promise<ShopVipClub> {
    return this.request<ShopVipClub>('/admin/shop/guests', {
      method: 'PUT',
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

  /** What checkout asks for. */
  adminUpdateCheckoutFields(fields: CheckoutFields): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/checkout-fields', {
      method: 'PUT',
      body: JSON.stringify(fields),
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
  /** Administrators: product testing on or off for the GB. */
  adminSetTestingEnabled(enabled: boolean): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/testing', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  }

  adminGetTestings(): Promise<Testing[]> {
    return this.request<Testing[]>('/admin/testings');
  }

  adminCreateTesting(input: CreateTestingRequest): Promise<Testing> {
    return this.request<Testing>('/admin/testings', { method: 'POST', body: JSON.stringify(input) });
  }

  adminUpdateTesting(id: string, input: UpdateTestingRequest): Promise<Testing> {
    return this.request<Testing>(`/admin/testings/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  adminDeleteTesting(id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(`/admin/testings/${id}`, { method: 'DELETE' });
  }

  /** A product's testings (lab tests paid between its buyers). */
  getProductTestings(productId: string): Promise<Testing[]> {
    return this.request<Testing[]>(`/products/${productId}/testings`);
  }

  /** Administrators: the GB's currency (minimum, margin, new products). */
  adminUpdateShopCurrency(currency: 'USDC' | 'EURC'): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/currency', {
      method: 'PUT',
      body: JSON.stringify({ currency }),
    });
  }

  /** Administrators: paying up to this much too much counts as the price (minor units). */
  adminUpdateOverpayMargin(amount: number): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/overpay-margin', {
      method: 'PUT',
      body: JSON.stringify({ amount }),
    });
  }

  adminUpdateAutoCancel(hours: number): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/auto-cancel', {
      method: 'PUT',
      body: JSON.stringify({ hours }),
    });
  }

  adminUpdateOrderFee(
    orderFee: number,
    orderFeeLabel: string,
    vipOrderFee?: number | null,
  ): Promise<ShopAdminView> {
    return this.request<ShopAdminView>('/admin/shop/fee', {
      method: 'PUT',
      body: JSON.stringify({ orderFee, orderFeeLabel, vipOrderFee }),
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

  /** Everything owed back to customers in this GB, with why. */
  adminPendingRefunds(): Promise<PendingRefund[]> {
    return this.request<PendingRefund[]>('/admin/refunds');
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
    extra: { note?: string; trackingNumber?: string; carrier?: string; force?: boolean } = {},
  ): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...extra }),
    });
  }

  /** Corrects the carrier or tracking of a shipped order (the customer is told). */
  adminUpdateShipment(orderId: string, shipment: { carrier: string; trackingNumber: string }): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}/shipment`, { method: 'PATCH', body: JSON.stringify(shipment) });
  }

  /** Carriers already used in this GB, the most recent first. */
  adminCarriers(): Promise<string[]> {
    return this.request<string[]>('/admin/carriers');
  }

  /** What taking products out would leave, without doing it. */
  adminReducePreview(
    orderId: string,
    lines: Array<{ productId: string; variantId: string | null; quantity: number }>,
  ): Promise<ReducePreview> {
    return this.request<ReducePreview>(`/admin/orders/${orderId}/reduce-preview`, {
      method: 'POST',
      body: JSON.stringify({ lines }),
    });
  }

  /** Takes products out of an order or lowers quantities (only down); the customer is told why. */
  adminReduceOrder(
    orderId: string,
    lines: Array<{ productId: string; variantId: string | null; quantity: number }>,
    reason: string,
  ): Promise<Order> {
    return this.request<Order>(`/admin/orders/${orderId}/reduce`, {
      method: 'POST',
      body: JSON.stringify({ lines, reason }),
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
