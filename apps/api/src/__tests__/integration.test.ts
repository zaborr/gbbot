import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { createApp } from '../app.js';
import { base32Decode, createWebAdmin, removeWebAdmin, resetWebAdmin, totpCode } from '../services/webAdmins.js';
import { addWebNotice } from '../services/webNotices.js';
import type { Env } from '../config/env.js';
import { createDb, createPool, type Database } from '../db/client.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  cartItems,
  carts,
  categories,
  labs,
  orderItems,
  orders,
  productVariants,
  products,
  shops,
  testingEntries,
  testingExtraMembers,
  testingReports,
  testings,
  bots,
  botSwitches,
  creatorAccounts,
  botSettings,
  webNotices,
  users,
} from '../db/schema.js';
import { runRetention } from '../services/retention.js';
import { cancelExpiredOrders } from '../services/autoCancel.js';
import { markOrderPaid } from '../services/orders.js';
import { assertProductKeepsTestings, dropUnpaidTesting } from '../services/testing.js';
import { goalTotals } from '../services/goal.js';
import { cancelDrawsOnReopen, finishDraw, launchDraw } from '../services/testingDraw.js';
import { botToken, loadActiveBot, useBot } from '../services/activeBot.js';
import { switchBot } from '../services/botSwitch.js';
import { resetVipCache } from '../services/vip.js';
import { closeDonationWindows, openDonationWindows } from '../services/testingDonations.js';
import { advanceExtras } from '../services/testingExtra.js';
import {
  addCreatorAccount,
  checkCreatorAccounts,
  listCreatorAccounts,
  removeCreatorAccount,
  submitCreatorCode,
  submitCreatorPassword,
} from '../services/creatorAccounts.js';
import { CreatorError, type CreatorApi } from '../services/creator.js';
import { createReserve, keepReserve, retireBot } from '../services/botReserve.js';
import { resetWatch, watchBot, watchStatus } from '../services/botWatch.js';
import { announceSwitch } from '../services/botNotices.js';
import { open as openSecret, seal, secretKey } from '../lib/secretBox.js';
import { sendPaymentReminders } from '../services/reminders.js';
import { resetMiniAppUrlCache } from '../services/bot.js';
import { closeDueShops } from '../services/closing.js';
import { deleteExpiredMessages } from '../services/expiringMessages.js';
import { TelegramApi, TelegramError } from '../telegram/api.js';

/**
 * Full-stack integration test against a real Postgres. Skipped automatically
 * when TEST_DATABASE_URL is not set (e.g. a plain `npm test` with no database);
 * CI provides a Postgres service and sets the variable.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const BOT_TOKEN = '7654321:AAFakeBotTokenForIntegration_0123456789';
const ADMIN_ID = 706626062;
const CUSTOMER_ID = 555000111;

function signInitData(userId: number, firstName: string, username?: string): string {
  const fields: Record<string, string> = {
    user: JSON.stringify({ id: userId, first_name: firstName, ...(username ? { username } : {}) }),
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAItest',
  };
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describeDb('API integration', () => {
  let pool: Pool;
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let shopId: string;
  let productId: string;
  let testEnv: Env;

  // Telegram is never reached: the bot's fake tokens are refused at once, as
  // Telegram would, without waiting on the network (a slow answer timed tests out).
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://api.telegram.org/')) {
        return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeAll(async () => {
    pool = createPool(DATABASE_URL as string);
    db = createDb(pool);
    await migrate(db, { migrationsFolder: './drizzle' });

    // Clean slate, then seed one shop / category / product deterministically.
    await db.delete(shops);
    const [shop] = await db
      .insert(shops)
      .values({
        name: 'Test Shop',
        slug: `test-shop-${Date.now()}`,
        description: '',
        currency: 'USDC',
      })
      .returning();
    shopId = shop!.id;
    const [cat] = await db
      .insert(categories)
      .values({ shopId, slug: 'tea', title: 'Tea', sortOrder: 1 })
      .returning();
    const [product] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: cat!.id,
        slug: 'sencha',
        title: 'Sencha',
        description: 'Green tea',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    productId = product!.id;

    const env: Env = {
      PORT: 0,
      DATABASE_URL: DATABASE_URL as string,
      BOT_TOKEN,
      JWT_SECRET: 'integration-secret-32-characters-long',
      JWT_TTL_SECONDS: 3600,
      INITDATA_MAX_AGE_SECONDS: 86_400,
      ADMIN_TELEGRAM_IDS: [ADMIN_ID],
      TELEGRAM_WEBHOOK_SECRET: 'whsec-test',
      CORS_ORIGIN: '*',
    };
    testEnv = env;
    app = createApp({ env, db });
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Requests go to the test GB unless they name another one (`X-Shop`). */
  function request(path: string, init: RequestInit = {}): Response | Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('X-Shop')) headers.set('X-Shop', shopId);
    return app.request(path, { ...init, headers });
  }

  async function authToken(
    userId: number,
    name: string,
    username?: string,
    { withPhrase = true }: { withPhrase?: boolean } = {},
  ): Promise<string> {
    const res = await request('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: signInitData(userId, name, username) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    // Ordering needs a security phrase: test users have one unless a test says otherwise.
    if (withPhrase) {
      await db
        .update(users)
        .set({ securityPhrase: seal(secretKey(testEnv), 'test phrase') })
        .where(and(eq(users.telegramId, userId), isNull(users.securityPhrase)));
    }
    return body.token;
  }

  it('rejects auth with tampered initData', async () => {
    const bad = signInitData(CUSTOMER_ID, 'Eve').replace('Eve', 'Mallory');
    const res = await request('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: bad }),
    });
    expect(res.status).toBe(401);
  });

  it('lists catalog publicly', async () => {
    const res = await request('/api/products');
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: unknown[]; total: number };
    expect(page.total).toBeGreaterThanOrEqual(1);
  });

  it('runs the cart → order → payment flow', async () => {
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // Add to cart
    const add = await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 2 }),
    });
    expect(add.status).toBe(200);
    const cart = (await add.json()) as { total: number; itemCount: number };
    expect(cart.total).toBe(300);
    expect(cart.itemCount).toBe(2);

    // Create order
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    expect(create.status).toBe(201);
    const { orderId } = (await create.json()) as { orderId: string };

    // Order is pending
    const before = await request(`/api/orders/${orderId}`, { headers: auth });
    expect(((await before.json()) as { status: string }).status).toBe('pending');

    // The organiser confirms the payment
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const confirm = await request(`/api/admin/orders/${orderId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paid' }),
    });
    expect(confirm.status).toBe(200);

    // Order is now paid, stock decremented 10 → 8
    const after = await request(`/api/orders/${orderId}`, { headers: auth });
    expect(((await after.json()) as { status: string }).status).toBe('paid');
    const prod = await request(`/api/products/${productId}`);
    expect(((await prod.json()) as { stock: number }).stock).toBe(8);
  });

  it('lets the customer edit an unpaid order at once, without approval', async () => {
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 2 }),
    });
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };
    await db
      .update(orders)
      .set({ updatedAt: new Date(Date.now() - 10 * 3_600_000), paymentReminderAt: new Date() })
      .where(eq(orders.id, orderId));

    const edit = await request(`/api/orders/${orderId}/change`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ items: [{ productId, quantity: 3 }] }),
    });
    expect(edit.status).toBe(200);
    const edited = (await edit.json()) as {
      status: string;
      total: number;
      changeRequest: unknown;
      items: Array<{ quantity: number }>;
    };
    expect(edited).toMatchObject({ status: 'pending', total: 450, changeRequest: null });
    expect(edited.items.map((i) => i.quantity)).toEqual([3]);
    // The countdown to auto-cancel starts again, and a new reminder can be sent.
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(Date.now() - row!.updatedAt.getTime()).toBeLessThan(60_000);
    expect(row!.paymentReminderAt).toBeNull();

    await request(`/api/orders/${orderId}`, { method: 'DELETE', headers: auth });
  });

  it('rejects the webhook with a wrong secret', async () => {
    const res = await request('/webhook/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
      body: JSON.stringify({ update_id: 2 }),
    });
    expect(res.status).toBe(401);
  });

  it('moves orders through admin statuses and returns stock on cancel', async () => {
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const adminAuth = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const stock = async (): Promise<number> => {
      const res = await request(`/api/products/${productId}`);
      return ((await res.json()) as { stock: number }).stock;
    };
    const setStatus = (orderId: string, body: Record<string, unknown>): Promise<Response> =>
      Promise.resolve(
        request(`/api/admin/orders/${orderId}`, {
          method: 'PATCH',
          headers: adminAuth,
          body: JSON.stringify(body),
        }),
      );

    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };
    const before = await stock();

    // An unpaid order cannot be shipped.
    expect((await setStatus(orderId, { status: 'shipped' })).status).toBe(409);

    // Manual confirmation takes the stock.
    const paid = await setStatus(orderId, { status: 'paid' });
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { status: string }).status).toBe('paid');
    expect(await stock()).toBe(before - 1);

    // Cancelling a paid order gives the stock back and owes the money.
    const cancelled = await setStatus(orderId, { status: 'cancelled', note: 'Sold out' });
    expect(cancelled.status).toBe(200);
    const body = (await cancelled.json()) as {
      status: string;
      amountDue: number;
      statusNote: string | null;
    };
    expect(body.status).toBe('cancelled');
    expect(body.amountDue).toBe(-150);
    expect(body.statusNote).toBe('Sold out');
    expect(await stock()).toBe(before);
  });

  it('anonymizes closed orders and deletes inactive users (data retention)', async () => {
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const adminAuth = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };

    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };
    for (const status of ['paid', 'fulfilled']) {
      const res = await request(`/api/admin/orders/${orderId}`, {
        method: 'PATCH',
        headers: adminAuth,
        body: JSON.stringify({ status }),
      });
      expect(res.status).toBe(200);
    }

    // Closed 31 days ago; and someone who has not opened the app since then.
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await db.update(orders).set({ closedAt: old }).where(eq(orders.id, orderId));
    await db.insert(users).values({ telegramId: 999000111, firstName: 'Ghost', lastSeenAt: old });

    const report = await runRetention(db);
    expect(report.ordersAnonymized).toBeGreaterThanOrEqual(1);
    expect(report.usersDeleted).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row?.userId).toBeNull();
    expect(row?.anonymizedAt).not.toBeNull();
    expect(row?.contactUsername).not.toBeNull();
    const ghost = await db.select().from(users).where(eq(users.telegramId, 999000111));
    expect(ghost).toHaveLength(0);

    // The customer no longer sees it; the active customer is kept.
    const mine = (await (await request('/api/orders', { headers: auth })).json()) as Array<{
      id: string;
    }>;
    expect(mine.some((o) => o.id === orderId)).toBe(false);
    const alice = await db.select().from(users).where(eq(users.telegramId, CUSTOMER_ID));
    expect(alice).toHaveLength(1);
  });

  it('reserves stock when a payment is sent and releases it when rejected', async () => {
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const adminAuth = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const stock = async (): Promise<number> =>
      ((await (await request(`/api/products/${productId}`)).json()) as { stock: number }).stock;

    await db
      .update(shops)
      .set({
        paymentSetup: {
          evmAddress: '0xabc0000000000000000000000000000000000000',
          solanaAddress: null,
          accepted: [{ chain: 'base', token: 'USDC' }],
        },
      })
      .where(eq(shops.id, shopId));
    const config = (await (await request('/api/shop')).json()) as {
      paymentMethods: Array<{ id: string }>;
    };
    const methodId = config.paymentMethods[0]!.id;

    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };
    const before = await stock();

    const pay = (txHash: string): Promise<Response> =>
      Promise.resolve(
        request(`/api/orders/${orderId}/payment`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ methodId, txHash }),
        }),
      );
    const setStatus = (status: string): Promise<Response> =>
      Promise.resolve(
        request(`/api/admin/orders/${orderId}`, {
          method: 'PATCH',
          headers: adminAuth,
          body: JSON.stringify({ status }),
        }),
      );

    expect((await pay(`0x${'a'.repeat(64)}`)).status).toBe(200);
    expect(await stock()).toBe(before - 1);

    expect((await setStatus('pending')).status).toBe(200);
    expect(await stock()).toBe(before);

    expect((await pay(`0x${'b'.repeat(64)}`)).status).toBe(200);
    expect(await stock()).toBe(before - 1);
    expect((await setStatus('paid')).status).toBe(200);
    // Confirming does not take the stock a second time.
    expect(await stock()).toBe(before - 1);
  });

  it('takes a payment in the other token at the GB rate', async () => {
    const auth = { Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`, 'content-type': 'application/json' };
    const adminAuth = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Ivan')}`, 'content-type': 'application/json' };
    const setup = (rate: number | null) => ({
      evmAddress: '0xabc0000000000000000000000000000000000000',
      solanaAddress: null,
      accepted: [
        { chain: 'base' as const, token: 'USDC' as const },
        { chain: 'base' as const, token: 'EURC' as const },
      ],
      exchange: { EURC: null, USDC: rate },
    });
    await db.update(shops).set({ paymentSetup: setup(9500) }).where(eq(shops.id, shopId));
    const config = (await (await request('/api/shop')).json()) as { exchangeRates: { USDC: number | null } };
    expect(config.exchangeRates.USDC).toBe(9500);

    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 1 }) });
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };
    const pay = (txHash: string): Promise<Response> =>
      Promise.resolve(
        request(`/api/orders/${orderId}/payment`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ methodId: 'eurc-base', txHash }),
        }),
      );

    const paid = await pay(`0x${'c'.repeat(64)}`);
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { paymentExchange: unknown }).paymentExchange).toEqual({ token: 'EURC', rate: 9500 });

    // Without a rate, the other token is refused.
    await db.update(shops).set({ paymentSetup: setup(null) }).where(eq(shops.id, shopId));
    const refused = await pay(`0x${'d'.repeat(64)}`);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('no_exchange');

    const confirmed = await request(`/api/admin/orders/${orderId}`, {
      method: 'PATCH',
      headers: adminAuth,
      body: JSON.stringify({ status: 'paid', force: true }),
    });
    expect(confirmed.status).toBe(200);
    const order = (await (await request(`/api/orders/${orderId}`, { headers: auth })).json()) as {
      total: number;
      paymentLog: Array<{ amount: number; paid?: { amount: number; token: string; rate: number } }>;
    };
    const entry = order.paymentLog[order.paymentLog.length - 1];
    expect(entry?.amount).toBe(order.total);
    expect(entry?.paid).toEqual({ token: 'EURC', rate: 9500, amount: Math.ceil((order.total * 9500) / 10_000) });
  });

  it('deletes every product of a GB at once, administrators only', async () => {
    const MANAGER = 555000777;
    const admin = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Ivan')}`, 'content-type': 'application/json' };
    const manager = { Authorization: `Bearer ${await authToken(MANAGER, 'Mia')}`, 'content-type': 'application/json' };
    const [gb] = await db
      .insert(shops)
      .values({ slug: `wipe-${Date.now()}`, name: 'Wipe', adminIds: [MANAGER], currency: 'USDC' })
      .returning();
    await db.insert(products).values(
      ['a', 'b'].map((slug) => ({
        shopId: gb!.id,
        slug,
        title: slug,
        description: '',
        price: 100,
        currency: 'USDC',
        stock: null,
        isActive: true,
      })),
    );
    const wipe = (headers: Record<string, string>, confirmCount: number): Promise<Response> =>
      Promise.resolve(
        request('/api/admin/products/delete-all', {
          method: 'POST',
          headers: { ...headers, 'X-Shop': gb!.slug },
          body: JSON.stringify({ confirmCount }),
        }),
      );
    expect((await wipe(manager, 2)).status).toBe(403);
    expect((await wipe(admin, 3)).status).toBe(409);
    const done = await wipe(admin, 2);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ deleted: 2, archived: 0 });
    expect(await db.select().from(products).where(eq(products.shopId, gb!.id))).toHaveLength(0);
    await db.delete(shops).where(eq(shops.id, gb!.id));
  });

  it('shows the progress towards the GB minimum', async () => {
    const auth = { Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`, 'content-type': 'application/json' };
    const adminAuth = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Ivan')}`, 'content-type': 'application/json' };
    const goalOf = async (headers: Record<string, string>) =>
      ((await (await request('/api/shop', { headers })).json()) as {
        goal: { target: number | null; paid: number | null; ordered: number | null; paidPercent: number; orderedPercent: number; reached: boolean } | null;
      }).goal;

    const set = await request('/api/admin/shop/goal', {
      method: 'PUT',
      headers: adminAuth,
      body: JSON.stringify({ amount: 1_000_000, showAmount: false }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ goalAmount: 1_000_000, goalShowAmount: false });

    const before = await goalOf(auth);
    // Customers see only percentages; the team sees amounts.
    expect(before).toMatchObject({ target: null, paid: null, ordered: null, reached: false });
    const team = await goalOf(adminAuth);
    expect(team?.target).toBe(1_000_000);

    // A new unpaid order counts as ordered, not as paid.
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 1 }) });
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };
    const after = await goalOf(adminAuth);
    expect(after!.ordered).toBeGreaterThan(team!.ordered ?? 0);
    expect(after!.paid).toBe(team!.paid);

    await request(`/api/orders/${orderId}`, { method: 'DELETE', headers: auth });
    await request('/api/admin/shop/goal', {
      method: 'PUT',
      headers: adminAuth,
      body: JSON.stringify({ amount: null, showAmount: true }),
    });
    expect(await goalOf(auth)).toBeNull();
  });

  it('lets a super-admin leave a GB without administrators', async () => {
    const admin = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Ivan')}`, 'content-type': 'application/json' };
    const [gb] = await db
      .insert(shops)
      .values({ slug: `noowner-${Date.now()}`, name: 'No owner', currency: 'USDC' })
      .returning();
    const res = await request('/api/admin/shop/owner', {
      method: 'PUT',
      headers: { ...admin, 'X-Shop': gb!.slug },
      body: JSON.stringify({ isVisible: false, vipOnly: false, owners: [], admins: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ownerIds: [], isVisible: false });
    await db.delete(shops).where(eq(shops.id, gb!.id));
  });

  it('refuses an order below the product minimum', async () => {
    const auth = { Authorization: `Bearer ${await authToken(555000888, 'Nora')}`, 'content-type': 'application/json' };
    await db.update(products).set({ minQuantity: 3 }).where(eq(products.id, productId));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 2 }) });
    const short = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: { code: string } }).error.code).toBe('below_minimum');
    await db.update(products).set({ minQuantity: 1 }).where(eq(products.id, productId));
  });

  it('signs platform admins in on the web, only through the onion address', async () => {
    const creds = await createWebAdmin(db, `web${Date.now() % 100000}`);
    const secret = base32Decode(creds.totpSecret);
    const code = (offset = 0): string => totpCode(secret, Math.floor(Date.now() / 30_000) + offset);
    const signIn = (host: string, body: Record<string, string>): Promise<Response> =>
      Promise.resolve(
        app.request(`http://${host}/api/auth/web`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

    expect((await signIn('gb.example.com', { username: creds.username, password: creds.password, code: code() })).status).toBe(403);
    expect((await signIn('abc.onion', { username: creds.username, password: 'nope', code: code() })).status).toBe(401);

    const now = code();
    const ok = await signIn('abc.onion', { username: creds.username, password: creds.password, code: now });
    expect(ok.status).toBe(200);
    const { token, user } = (await ok.json()) as { token: string; user: { role: string; telegramId: number } };
    expect(user.role).toBe('admin');
    expect(user.telegramId).toBeLessThan(0);
    // The same code works once.
    expect((await signIn('abc.onion', { username: creds.username, password: creds.password, code: now })).status).toBe(401);

    // A web admin is a platform super-admin.
    const auth = { Authorization: `Bearer ${token}` };
    expect((await app.request('/api/platform/shops', { headers: auth })).status).toBe(200);
    // Files come back in the response (there is no chat with the bot to send them to).
    const csv = await request('/api/admin/products/csv/export', { method: 'POST', headers: auth });
    expect(csv.status).toBe(200);
    const { file } = (await csv.json()) as { file?: { fileName: string; data: string } };
    expect(file?.fileName).toMatch(/\.csv$/);
    expect(Buffer.from(file?.data ?? '', 'base64').toString('utf8')).toContain('producto');
    // No cart or orders of their own.
    expect((await request('/api/cart', { headers: auth })).status).toBe(403);

    // Their inbox: what Telegram admins get from the bot, in their language.
    await addWebNotice(db, (lang) => `notice-${lang}`);
    const unread = await app.request('/api/platform/notices/unread', { headers: auth });
    expect(((await unread.json()) as { unread: number }).unread).toBeGreaterThan(0);
    const inbox = await app.request('/api/platform/notices', { headers: { ...auth, 'X-Lang': 'es' } });
    const { notices } = (await inbox.json()) as { notices: { id: number; text: string }[] };
    expect(notices[0]?.text).toBe('notice-es');
    await app.request('/api/platform/notices/seen', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ upTo: notices[0]?.id ?? 0 }),
    });
    const after = await app.request('/api/platform/notices/unread', { headers: auth });
    expect(((await after.json()) as { unread: number }).unread).toBe(0);
    // Full platform accounts may delete; the deletion leaves its own notice.
    const one = notices[0]?.id ?? 0;
    expect((await app.request(`/api/platform/notices/${one}`, { method: 'DELETE', headers: auth })).status).toBe(204);
    const left = await app.request('/api/platform/notices', { headers: auth });
    const listed = ((await left.json()) as { notices: { id: number; text: string }[] }).notices;
    expect(listed.some((n) => n.id === one)).toBe(false);
    expect(listed[0]?.text).toContain('web:');

    // A reset closes the sessions opened before.
    await resetWebAdmin(db, creds.username);
    expect((await app.request('/api/platform/shops', { headers: auth })).status).toBe(401);
    await removeWebAdmin(db, creds.username);
  });

  it('lets full platform accounts manage web accounts', async () => {
    const webSignIn = async (creds: { username: string; password: string; totpSecret: string }) => {
      const code = totpCode(base32Decode(creds.totpSecret), Math.floor(Date.now() / 30_000));
      const res = await app.request('http://abc.onion/api/auth/web', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: creds.username, password: creds.password, code }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; webRole: string };
      return { body, auth: { Authorization: `Bearer ${body.token}`, 'content-type': 'application/json' } };
    };
    const stamp = Date.now() % 100000;
    const full = await createWebAdmin(db, `full${stamp}`);
    const { body: fullBody, auth } = await webSignIn(full);
    expect(fullBody.webRole).toBe('platform');

    const created = await app.request('/api/web-accounts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ username: `lim${stamp}`, role: 'platform_limited' }),
    });
    expect(created.status).toBe(201);
    const limited = (await created.json()) as { username: string; password: string; totpSecret: string };
    const list = (await (await app.request('/api/web-accounts', { headers: auth })).json()) as {
      id: number;
      username: string;
      isMe: boolean;
    }[];
    const limitedId = list.find((a) => a.username === limited.username)?.id;
    const fullId = list.find((a) => a.isMe)?.id;
    expect(limitedId).toBeDefined();

    // A limited account manages everything but web accounts.
    const { auth: limitedAuth } = await webSignIn(limited);
    expect((await app.request('/api/platform/shops', { headers: limitedAuth })).status).toBe(200);
    expect((await app.request('/api/web-accounts', { headers: limitedAuth })).status).toBe(403);

    // The last full account can be neither removed nor downgraded.
    expect((await app.request(`/api/web-accounts/${fullId}`, { method: 'DELETE', headers: auth })).status).toBe(409);
    const downgrade = await app.request(`/api/web-accounts/${fullId}/role`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ role: 'platform_limited' }),
    });
    expect(downgrade.status).toBe(409);

    // Own password: the caller gets a fresh session, older ones end.
    const changed = await app.request('/api/web-accounts/me/password', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ current: full.password, next: 'a-new-long-password' }),
    });
    expect(changed.status).toBe(200);
    const { token } = (await changed.json()) as { token: string };
    expect((await app.request('/api/web-accounts', { headers: auth })).status).toBe(401);
    const fresh = { Authorization: `Bearer ${token}` };
    expect((await app.request('/api/web-accounts', { headers: fresh })).status).toBe(200);

    expect(
      (await app.request(`/api/web-accounts/${limitedId}`, { method: 'DELETE', headers: fresh })).status,
    ).toBe(204);
    await removeWebAdmin(db, full.username);
  });

  it('lets managers activate web access from Telegram, acting as themselves', async () => {
    const webSignIn = (body: Record<string, string>): Promise<Response> =>
      Promise.resolve(
        app.request('http://abc.onion/api/auth/web', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    // Customers who manage nothing cannot.
    const customer = { Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}` };
    expect((await request('/api/me/web-access', { headers: customer })).status).toBe(403);

    const tg = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const username = `link${Date.now() % 100000}`;
    const created = await request('/api/me/web-access', {
      method: 'POST',
      headers: tg,
      body: JSON.stringify({ username }),
    });
    expect(created.status).toBe(201);
    const creds = (await created.json()) as { password: string; totpSecret: string };
    const secret = base32Decode(creds.totpSecret);
    const code = totpCode(secret, Math.floor(Date.now() / 30_000));

    const ok = await webSignIn({ username, password: creds.password, code });
    expect(ok.status).toBe(200);
    const { token, user } = (await ok.json()) as { token: string; user: { telegramId: number } };
    // The web session is the Telegram user, with the same permissions…
    expect(user.telegramId).toBe(ADMIN_ID);
    const web = { Authorization: `Bearer ${token}` };
    expect((await request('/api/admin/products', { headers: web })).status).toBe(200);
    // …but only to manage: no cart, and no web access screens from the web.
    expect((await request('/api/cart', { headers: web })).status).toBe(403);
    expect((await request('/api/me/web-access', { headers: web })).status).toBe(403);

    // Renewing from Telegram closes the web sessions.
    const renewed = await request('/api/me/web-access/reset', { method: 'POST', headers: tg });
    expect(renewed.status).toBe(200);
    expect((await request('/api/admin/products', { headers: web })).status).toBe(401);

    expect((await request('/api/me/web-access', { method: 'DELETE', headers: tg })).status).toBe(204);
    const status = await request('/api/me/web-access', { headers: tg });
    expect(((await status.json()) as { account: unknown }).account).toBeNull();
  });

  it('hides the GB from blacklisted customers, here or on the whole platform', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const customer = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    const sees = async (): Promise<boolean> => {
      const list = (await (await request('/api/shops', { headers: customer })).json()) as {
        shops: { id: string }[];
      };
      return list.shops.some((s) => s.id === shopId);
    };
    expect(await sees()).toBe(true);
    await request('/api/cart/items', {
      method: 'POST',
      headers: customer,
      body: JSON.stringify({ productId, quantity: 1 }),
    });

    // Before blocking, the admin sees what they have.
    const check = await request('/api/admin/blacklist/check', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID) }),
    });
    expect(((await check.json()) as { cartItems: number }).cartItems).toBeGreaterThan(0);
    // The team cannot be blocked.
    const self = await request('/api/admin/blacklist', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(ADMIN_ID), removeData: false }),
    });
    expect(self.status).toBe(400);

    const blocked = await request('/api/admin/blacklist', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID), removeData: true }),
    });
    expect(blocked.status).toBe(200);
    expect(await sees()).toBe(false);
    expect((await request('/api/shop', { headers: customer })).status).toBe(404);
    const after = await request('/api/admin/blacklist/check', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID) }),
    });
    expect(((await after.json()) as { cartItems: number }).cartItems).toBe(0);

    await request('/api/admin/blacklist/remove', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID) }),
    });
    expect(await sees()).toBe(true);

    // The platform blacklist hides every GB, and needs a reason.
    const bare = await app.request('/api/platform/blacklist', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID), removeData: false }),
    });
    expect(bare.status).toBe(400);
    await app.request('/api/platform/blacklist', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID), removeData: false, reason: 'Scam' }),
    });
    expect(await sees()).toBe(false);
    await app.request('/api/platform/blacklist/remove', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID) }),
    });
    expect(await sees()).toBe(true);

    // An organiser blocks in every GB from theirs: it replaces their own entry,
    // and the others see why and who.
    await request('/api/admin/blacklist', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID), removeData: false }),
    });
    const noReason = await request('/api/admin/blacklist', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID), removeData: false, scope: 'platform' }),
    });
    expect(noReason.status).toBe(400);
    const global = await request('/api/admin/blacklist', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID), removeData: false, scope: 'platform', reason: 'Did not pay' }),
    });
    expect(global.status).toBe(200);
    const listed = (await global.json()) as {
      people: Array<{ telegramId: number }>;
      platform: { people: Array<{ telegramId: number }>; notes: Record<string, { reason: string; by: string }> };
    };
    expect(listed.people.some((p) => p.telegramId === CUSTOMER_ID)).toBe(false);
    expect(listed.platform.people.some((p) => p.telegramId === CUSTOMER_ID)).toBe(true);
    expect(listed.platform.notes[String(CUSTOMER_ID)]).toMatchObject({ reason: 'Did not pay' });
    expect(listed.platform.notes[String(CUSTOMER_ID)]?.by).toBeTruthy();
    const known = await request('/api/admin/blacklist/check', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID) }),
    });
    expect(((await known.json()) as { platformNote: { reason: string } | null }).platformNote).toMatchObject({
      reason: 'Did not pay',
    });
    expect(await sees()).toBe(false);
    await app.request('/api/platform/blacklist/remove', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID) }),
    });
    expect(await sees()).toBe(true);
  });

  it('sets up product testings per product or variant', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const customer = { Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}` };
    const body = {
      productId,
      variantId: null,
      lab: 'Lab X',
      contribution: 2000,
      perUnit: 0,
      feeMode: 'optional',
      tiers: [
        { id: 'mp', name: 'M&P', cost: 20000, vials: 1 },
        { id: 'endo', name: 'Endo', cost: 10000, vials: 0 },
      ],
    };
    const create = (): Promise<Response> =>
      Promise.resolve(
        request('/api/admin/testings', { method: 'POST', headers: admin, body: JSON.stringify(body) }),
      );
    const toggle = (enabled: boolean): Promise<Response> =>
      Promise.resolve(
        request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled }) }),
      );

    // Off by default: nothing can be set up.
    expect((await create()).status).toBe(409);
    const on = await toggle(true);
    expect(((await on.json()) as { testingEnabled: boolean }).testingEnabled).toBe(true);

    const created = await create();
    expect(created.status).toBe(201);
    const testing = (await created.json()) as { id: string; currency: string; productTitle: string };
    expect(testing).toMatchObject({ currency: 'USDC', productTitle: 'Sencha' });
    // One per product (it has no variants), and a variant it does not have is refused.
    expect((await create()).status).toBe(409);
    const withVariant = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ ...body, variantId: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(withVariant.status).toBe(400);

    // Customers see it on the product, and in the GB's list.
    const seen = await request(`/api/products/${productId}/testings`, { headers: customer });
    expect(((await seen.json()) as unknown[]).length).toBe(1);
    const all = await request('/api/products/testings', { headers: customer });
    expect(((await all.json()) as unknown[]).length).toBe(1);

    // The product keeps its token while it has a testing.
    await expect(assertProductKeepsTestings(db, productId, 'EURC', false)).rejects.toThrow(/token/);
    await expect(assertProductKeepsTestings(db, productId, 'USDC', true)).rejects.toThrow(/variants/);
    await assertProductKeepsTestings(db, productId, 'USDC', false);

    // Editing the tiers.
    const edited = await request(`/api/admin/testings/${testing.id}`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ ...body, productId: undefined, variantId: undefined, lab: 'Lab Y' }),
    });
    expect(((await edited.json()) as { lab: string }).lab).toBe('Lab Y');

    // Off only once its testings are finished (or deleted).
    expect((await toggle(false)).status).toBe(409);
    const removed = await request(`/api/admin/testings/${testing.id}`, { method: 'DELETE', headers: admin });
    expect(removed.status).toBe(200);
    expect((await toggle(false)).status).toBe(200);
  });

  it('lets buyers of the tested product join a testing with their order', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab',
        contribution: 2000,
        perUnit: 0,
        feeMode: 'optional',
        tiers: [{ id: 'mp', name: 'M&P', cost: 2000, vials: 1 }],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };
    const join = (): Promise<Response> =>
      Promise.resolve(
        request('/api/cart/testings', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ testingId, volunteer: true }),
        }),
      );

    // Only with the product in the cart.
    expect((await join()).status).toBe(409);
    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const cart = (await (await join()).json()) as {
      total: number;
      lines: Array<{ subtotal: number }>;
      testings: Array<{ amount: number; volunteer: boolean }>;
    };
    expect(cart.testings).toEqual([expect.objectContaining({ amount: 2000, volunteer: true })]);
    const items = cart.lines.reduce((sum, line) => sum + line.subtotal, 0);
    expect(cart.total).toBe(items + 2000);

    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    const order = (await (await request(`/api/orders/${orderId}`, { headers: auth })).json()) as {
      total: number;
      testing: number;
    };
    expect(order).toMatchObject({ total: items + 2000, testing: 2000 });
    interface Seen {
      participants: number;
      joined: boolean;
      money: unknown;
      tiers: Array<Record<string, unknown>>;
    }
    const listed = async (): Promise<Seen> => {
      const res = await request(`/api/products/${productId}/testings`, { headers: auth });
      return ((await res.json()) as Seen[])[0]!;
    };
    const money = async (): Promise<{ pot: number; units: number; pendingUnits: number; fees: number }> => {
      const res = await request('/api/admin/testings', { headers: admin });
      return ((await res.json()) as Array<{ id: string; money: { pot: number; units: number; pendingUnits: number; fees: number } }>).find(
        (x) => x.id === testingId,
      )!.money;
    };
    const first = await listed();
    expect(first).toMatchObject({ participants: 0, joined: true, money: null });
    // Customers see no money: no cost, no pot.
    expect(first.tiers[0]).not.toHaveProperty('cost');
    expect(await money()).toMatchObject({ pot: 0, fees: 0 });

    // Counted once the whole order is paid; and one entry per person.
    await request(`/api/admin/orders/${orderId}`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ status: 'paid' }),
    });
    expect(await listed()).toMatchObject({ participants: 1 });
    expect(await money()).toMatchObject({ pot: 2000, fees: 2000 });
    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    expect((await join()).status).toBe(409);
    const participants = await request(`/api/admin/testings/${testingId}/participants`, { headers: admin });
    expect(await participants.json()).toEqual([
      expect.objectContaining({
        contact: 'alice_test',
        paid: true,
        volunteer: true,
        amount: 2000,
        extra: 0,
        units: 1,
        ref: orderId.slice(0, 8),
        external: false,
        donor: false,
      }),
    ]);
    // Everyone paid: nobody to remind.
    const reminded = await request(`/api/admin/testings/${testingId}/remind`, { method: 'POST', headers: admin });
    expect(await reminded.json()).toEqual({ sent: 0 });
    // The organisers' order list says which testing the order is in.
    const listedOrders = (await (await request('/api/admin/orders', { headers: admin })).json()) as Array<{
      id: string;
      testings?: Array<{ id: string; label: string }>;
    }>;
    expect(listedOrders.find((o) => o.id === orderId)?.testings).toEqual([{ id: testingId, label: expect.any(String) }]);
    // Taken part in: it cannot be deleted, nor its tiers changed.
    expect((await request(`/api/admin/testings/${testingId}`, { method: 'DELETE', headers: admin })).status).toBe(409);

    await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await db.delete(orders).where(eq(orders.id, orderId));
    await request(`/api/admin/testings/${testingId}`, { method: 'DELETE', headers: admin });
    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
  });

  it('adds a testing to a paid order, and drops it if unpaid when the GB closes', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'optional',
        tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 1 }],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };

    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 1 }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
    const before = (await goalTotals(db, [shopId])).get(shopId);

    const added = await request(`/api/orders/${orderId}/testings`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ testingId, volunteer: true }),
    });
    expect(added.status).toBe(200);
    const order = (await added.json()) as { status: string; testing: number; amountDue: number };
    expect(order).toMatchObject({ status: 'pending', testing: 1000, amountDue: 1000 });
    // Its products still count as paid towards the GB minimum.
    expect((await goalTotals(db, [shopId])).get(shopId)).toEqual(before);

    // Unpaid when the GB closes: the testing drops out and the order is paid again.
    expect(await dropUnpaidTesting(db, shopId)).toBe(1);
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row).toMatchObject({ status: 'paid', testing: 0 });

    await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await db.delete(orders).where(eq(orders.id, orderId));
    await request(`/api/admin/testings/${testingId}`, { method: 'DELETE', headers: admin });
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
  });

  it('when the GB closes, keeps the testings its payment covers and drops only the others', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [second] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: `matcha-two-${Date.now()}`,
        title: 'Matcha',
        description: '',
        price: 2000,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const make = async (tested: string): Promise<string> => {
      const res = await request('/api/admin/testings', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          productId: tested,
          variantId: null,
          lab: 'Lab',
          contribution: 1000,
          perUnit: 0,
          feeMode: 'optional',
          tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 1 }],
        }),
      });
      return ((await res.json()) as { id: string }).id;
    };
    const first = await make(productId);
    const later = await make(second!.id);
    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 1 }) });
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId: second!.id, quantity: 1 }) });
    await request('/api/cart/testings', { method: 'POST', headers: auth, body: JSON.stringify({ testingId: first, volunteer: false }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    try {
      // Paid with the first testing; the second joined later and not paid.
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      const added = await request(`/api/orders/${orderId}/testings`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ testingId: later, volunteer: false }),
      });
      expect(added.status).toBe(200);
      expect(await dropUnpaidTesting(db, shopId)).toBe(1);
      const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(row).toMatchObject({ status: 'paid', testing: 1000 });
      const left = await db.select().from(testingEntries).where(eq(testingEntries.orderId, orderId));
      expect(left.map((e) => e.testingId)).toEqual([first]);
    } finally {
      await db.delete(testingEntries).where(eq(testingEntries.orderId, orderId));
      await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await db.delete(orders).where(eq(orders.id, orderId));
      await db.delete(testings).where(inArray(testings.id, [first, later]));
      await db.delete(products).where(eq(products.id, second!.id));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
      await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
    }
  });

  it('the organisers put people in a testing by hand, from outside too', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const send = vi.spyOn(TelegramApi.prototype, 'sendMessage').mockResolvedValue(true);
    const menu = vi
      .spyOn(TelegramApi.prototype, 'getChatMenuButton')
      .mockResolvedValue({ type: 'web_app', web_app: { url: 'https://app.example' } });
    resetMiniAppUrlCache();
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'optional',
        tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 1 }],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };
    // Someone who opened the bot once, with no order here; the testing takes nobody from outside.
    await authToken(555007001, 'Outsider', 'outsider_test');
    try {
      const add = (body: Record<string, unknown>) =>
        request(`/api/admin/testings/${testingId}/participants`, { method: 'POST', headers: admin, body: JSON.stringify(body) });
      const res = await add({ who: '@outsider_test', amount: 500, volunteer: true });
      expect(res.status).toBe(201);
      const { orderId, notified } = (await res.json()) as { orderId: string; notified: boolean };
      expect(notified).toBe(true);
      expect(send).toHaveBeenCalledWith(555007001, expect.any(String), expect.anything());
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(order).toMatchObject({ external: true, total: 500, testing: 500, status: 'pending', userId: 555007001 });
      const [entry] = await db.select().from(testingEntries).where(eq(testingEntries.orderId, orderId));
      expect(entry).toMatchObject({ amount: 500, volunteer: true });
      // Not twice; and not someone the bot has never seen.
      expect((await add({ who: '555007001' })).status).toBe(409);
      const unseen = await add({ who: '@nobody_seen_here' });
      expect(unseen.status).toBe(404);
      expect(((await unseen.json()) as { error: { message: string } }).error.message).toContain('not opened the bot');
    } finally {
      send.mockRestore();
      menu.mockRestore();
      resetMiniAppUrlCache();
      await db.delete(testingEntries).where(eq(testingEntries.testingId, testingId));
      await db.delete(orders).where(eq(orders.externalTestingId, testingId));
      await db.delete(testings).where(eq(testings.id, testingId));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('draws the donors with the next Bitcoin block, volunteers first', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'optional',
        tiers: [{ id: 'mp', name: 'M&P', cost: 500, vials: 1 }],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };
    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 1 }) });
    await request('/api/cart/testings', { method: 'POST', headers: auth, body: JSON.stringify({ testingId, volunteer: true }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
    // Someone else takes part too (not offering a vial): the donor's contribution goes back.
    const dan = {
      Authorization: `Bearer ${await authToken(555000777, 'Dan')}`,
      'content-type': 'application/json',
    };
    await request('/api/cart/items', { method: 'POST', headers: dan, body: JSON.stringify({ productId, quantity: 1 }) });
    await request('/api/cart/testings', { method: 'POST', headers: dan, body: JSON.stringify({ testingId, volunteer: false }) });
    const danPlaced = await request('/api/orders', {
      method: 'POST',
      headers: dan,
      body: JSON.stringify({ contactUsername: '@dan_test' }),
    });
    const { orderId: danOrder } = (await danPlaced.json()) as { orderId: string };
    await request(`/api/admin/orders/${danOrder}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });

    // Only once the GB is closed.
    expect((await request(`/api/admin/testings/${testingId}/draw`, { method: 'POST', headers: admin })).status).toBe(409);
    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    try {
      await db.update(testings).set({ status: 'closed' }).where(eq(testings.id, testingId));
      const status = await request(`/api/admin/testings/${testingId}/draw`, { headers: admin });
      expect(await status.json()).toEqual({ blocker: null });

      const hash = 'ab'.repeat(32);
      const explorer = (async (url: string | URL | Request) =>
        new Response(String(url).endsWith('/blocks/tip/height') ? '900000' : hash)) as unknown as typeof fetch;
      const shopRow = (await db.query.shops.findFirst({ where: eq(shops.id, shopId) }))!;
      const launched = await launchDraw(db, testEnv, shopRow, testingId, explorer);
      expect(launched.draw).toMatchObject({ height: 900001, hash: null });
      expect(launched.draw?.candidates).toEqual([
        expect.objectContaining({ orderId, volunteer: true, vialPrice: expect.any(Number) as number }),
        expect.objectContaining({ orderId: danOrder, volunteer: false }),
      ]);

      expect(await finishDraw(db, testEnv, launched, explorer)).toBe(true);
      const [drawn] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(drawn).toMatchObject({ status: 'drawn' });
      expect(drawn?.draw).toMatchObject({ hash, donors: [orderId.slice(0, 8)], tiersDone: ['mp'] });
      const [donor] = await db.select().from(orders).where(eq(orders.id, orderId));
      // One vial of a kit of 10 (the default).
      expect(donor?.donatedVials).toEqual(['Sencha · 1/10']);

      // Opening the GB again cancels the draw (kept in its history) and the mark.
      await cancelDrawsOnReopen(db, testEnv, shopRow);
      const [reopened] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(reopened?.status).toBe('open');
      expect(reopened?.draw?.history).toHaveLength(1);
      const [cleared] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(cleared?.donatedVials).toEqual([]);
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
    }
    await db.delete(orderItems).where(inArray(orderItems.orderId, [orderId, danOrder]));
    await db.delete(orders).where(inArray(orders.id, [orderId, danOrder]));
    await request(`/api/admin/testings/${testingId}`, { method: 'DELETE', headers: admin });
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
  });

  it('fills the pot with fees, money on top and a hidden part per unit sold', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    // A product of its own: no orders from other tests count.
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'matcha-money',
        title: 'Matcha',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const tested = own!.id;
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId: tested,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 300,
        feeMode: 'optional',
        tiers: [
          { id: 'mp', name: 'M&P', cost: 1000, vials: 0 },
          { id: 'endo', name: 'Endo', cost: 5000, vials: 0 },
        ],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };
    const buy = async (
      userId: number,
      name: string,
      quantity: number,
      testing: { extra: number } | null,
    ): Promise<{ orderId: string; cart: { testings: Array<{ amount: number; extra: number }> } }> => {
      const headers = { Authorization: `Bearer ${await authToken(userId, name)}`, 'content-type': 'application/json' };
      await db.delete(carts).where(eq(carts.userId, userId));
      await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId: tested, quantity }) });
      if (testing) {
        await request('/api/cart/testings', {
          method: 'POST',
          headers,
          body: JSON.stringify({ testingId, volunteer: false, extra: testing.extra }),
        });
      }
      const cart = (await (await request('/api/cart', { headers })).json()) as {
        testings: Array<{ amount: number; extra: number }>;
      };
      const placed = await request('/api/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ contactUsername: `@${name.toLowerCase()}_test` }),
      });
      const { orderId } = (await placed.json()) as { orderId: string };
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      return { orderId, cart };
    };
    // Alice pays the fee and 5 more; Eve does not take part, but her unit counts too.
    const alice = await buy(CUSTOMER_ID, 'Alice', 2, { extra: 500 });
    expect(alice.cart.testings).toEqual([expect.objectContaining({ amount: 1500, extra: 500 })]);
    const eve = await buy(555000888, 'Eve', 1, null);
    try {
      const admins = ((await (await request('/api/admin/testings', { headers: admin })).json()) as Array<{
        id: string;
        money: Record<string, unknown>;
      }>).find((x) => x.id === testingId);
      // 10 + 5 + 3 × 3: the first tier is covered, 36 missing for the next.
      expect(admins?.money).toMatchObject({
        fees: 1000,
        extras: 500,
        perUnitTotal: 900,
        pot: 2400,
        units: 3,
        orders: 2,
        payers: 1,
        balance: 1400,
      });
      const customer = { Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}` };
      const [seen] = (await (await request(`/api/products/${tested}/testings`, { headers: customer })).json()) as Array<{
        money: unknown;
        tiers: Array<{ reached: boolean; unitsLeft: number | null }>;
      }>;
      expect(seen?.money).toBeNull();
      // Fewer than 5 orders: only the hidden part turns money into units (36 / 3).
      expect(seen?.tiers).toEqual([
        expect.objectContaining({ reached: true, unitsLeft: null }),
        expect.objectContaining({ reached: false, unitsLeft: 12 }),
      ]);
    } finally {
      await db.delete(orderItems).where(inArray(orderItems.orderId, [alice.orderId, eve.orderId]));
      await db.delete(orders).where(inArray(orders.id, [alice.orderId, eve.orderId]));
      await db.delete(testings).where(eq(testings.id, testingId));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
      await db.delete(products).where(eq(products.id, tested));
    }
  });

  it('lets those in a testing give at any time, also on sent orders; unpaid gifts come off', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'gyokuro-gifts',
        title: 'Gyokuro',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const tested = own!.id;
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId: tested,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'mandatory',
        donationHours: 1,
        tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 0 }],
      }),
    });
    const testing = (await created.json()) as { id: string; donationProductId: string };
    const testingId = testing.id;
    // Its donation product is not one of the GB's products.
    const listed = (await (await request('/api/admin/products', { headers: admin })).json()) as Array<{ id: string }>;
    expect(listed.some((p) => p.id === testing.donationProductId)).toBe(false);

    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId: tested, quantity: 1 }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
    const give = (amount: number): Promise<Response> =>
      Promise.resolve(
        request(`/api/orders/${orderId}/donations`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ testingId, amount }),
        }),
      );
    const pot = async (): Promise<{ donations: number; pot: number }> =>
      ((await (await request('/api/admin/testings', { headers: admin })).json()) as Array<{
        id: string;
        money: { donations: number; pot: number };
      }>).find((x) => x.id === testingId)!.money;

    const pay = (): Promise<Response> =>
      Promise.resolve(
        request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) }),
      );
    // While the GB is open, too.
    expect((await give(1000)).status).toBe(200);
    await pay();
    expect(await pot()).toMatchObject({ donations: 1000, pot: 2000 });
    // Sent already: it waits for the donation, then goes back to sent.
    await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'shipped' }) });
    const onSent = (await (await give(500)).json()) as { status: string; resumeStatus: string | null; donationDue: number };
    expect(onSent).toMatchObject({ status: 'pending', resumeStatus: 'shipped', donationDue: 500 });
    await pay();
    const [sent] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(sent).toMatchObject({ status: 'shipped', resumeStatus: null });
    expect(await pot()).toMatchObject({ donations: 1500 });
    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    try {
      await db.update(testings).set({ status: 'closed' }).where(eq(testings.id, testingId));
      const shopRow = (await db.query.shops.findFirst({ where: eq(shops.id, shopId) }))!;
      await openDonationWindows(db, testEnv, shopRow);
      const status = await request(`/api/admin/testings/${testingId}/draw`, { headers: admin });
      expect(await status.json()).toEqual({ blocker: 'donations_open' });

      // Whole units only; giving twice adds to the same line, and the order waits for it.
      expect((await give(250)).status).toBe(400);
      expect((await give(2000)).status).toBe(200);
      const more = await give(500);
      const order = (await more.json()) as { status: string; amountDue: number; items: Array<{ productId: string; quantity: number }> };
      expect(order).toMatchObject({ status: 'pending', amountDue: 2500 });
      expect(order.items.find((i) => i.productId === testing.donationProductId)?.quantity).toBe(40);
      // Not paid yet: not in the pot.
      expect(await pot()).toMatchObject({ donations: 1500, pot: 2500 });

      await pay();
      expect(await pot()).toMatchObject({ donations: 4000, pot: 5000 });

      // Given again and not paid when the time is up: it comes off, the order is sent again.
      expect((await give(700)).status).toBe(200);
      await closeDonationWindows(db, testEnv, new Date(Date.now() + 2 * 3600_000));
      const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(row?.status).toBe('shipped');
      expect((row?.total ?? 0) - (row?.amountPaid ?? 0)).toBe(0);
      expect(await pot()).toMatchObject({ donations: 4000 });
      const after = await request(`/api/admin/testings/${testingId}/draw`, { headers: admin });
      expect(await after.json()).toEqual({ blocker: null });
      expect((await give(100)).status).toBe(409);
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
      await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await db.delete(orders).where(eq(orders.id, orderId));
      await db.delete(testings).where(eq(testings.id, testingId));
      await db.delete(products).where(inArray(products.id, [tested, testing.donationProductId]));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('runs a testing made after closing: buyers join with their part, even on sent orders', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'hojicha-after',
        title: 'Hojicha',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const tested = own!.id;
    const buy = async (userId: number, name: string): Promise<{ orderId: string; headers: Record<string, string> }> => {
      const headers = { Authorization: `Bearer ${await authToken(userId, name)}`, 'content-type': 'application/json' };
      await db.delete(carts).where(eq(carts.userId, userId));
      await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId: tested, quantity: 1 }) });
      const placed = await request('/api/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ contactUsername: `@${name.toLowerCase()}_test` }),
      });
      const { orderId } = (await placed.json()) as { orderId: string };
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'shipped' }) });
      return { orderId, headers };
    };
    const alice = await buy(CUSTOMER_ID, 'Alice');
    const bob = await buy(555000999, 'Bob');
    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    let testingId = '';
    let donationProductId: string | null = null;
    try {
      const created = await request('/api/admin/testings', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          productId: tested,
          variantId: null,
          lab: 'Lab',
          contribution: 1000,
          perUnit: 200,
          feeMode: 'optional',
          donationHours: 2,
          tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 0 }],
        }),
      });
      expect(created.status).toBe(201);
      const testing = (await created.json()) as Record<string, unknown> & { id: string; donationProductId: string };
      testingId = testing.id;
      donationProductId = testing.donationProductId;
      // Made after closing: open to join for its hours, and there is no optional part.
      expect(testing).toMatchObject({ posterior: true, status: 'closed', donationsOpen: true, feeMode: 'mandatory' });

      const join = (who: { orderId: string; headers: Record<string, string> }): Promise<Response> =>
        Promise.resolve(
          request(`/api/orders/${who.orderId}/testings`, {
            method: 'POST',
            headers: who.headers,
            body: JSON.stringify({ testingId, volunteer: false }),
          }),
        );
      // A sent order can join: it waits for the part, then goes back to sent.
      expect((await join(alice)).status).toBe(200);
      const [waiting] = await db.select().from(orders).where(eq(orders.id, alice.orderId));
      expect(waiting).toMatchObject({ status: 'pending', resumeStatus: 'shipped' });
      await request(`/api/admin/orders/${alice.orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      const [joined] = await db.select().from(orders).where(eq(orders.id, alice.orderId));
      expect(joined?.status).toBe('shipped');

      // Bob joins and does not pay: kept while the time lasts, off when it is over.
      expect((await join(bob)).status).toBe(200);
      const shopRow = (await db.query.shops.findFirst({ where: eq(shops.id, shopId) }))!;
      expect(shopRow.closedAt).not.toBeNull();
      // What maintenance does on a closed GB: the time to join is not over, so Bob stays.
      await dropUnpaidTesting(db, shopId);
      expect((await db.select().from(testingEntries).where(eq(testingEntries.orderId, bob.orderId))).length).toBe(1);
      await closeDonationWindows(db, testEnv, new Date(Date.now() + 3 * 3600_000));
      expect((await db.select().from(testingEntries).where(eq(testingEntries.orderId, bob.orderId))).length).toBe(0);
      const [bobAfter] = await db.select().from(orders).where(eq(orders.id, bob.orderId));
      expect(bobAfter).toMatchObject({ status: 'shipped', testing: 0 });

      const [listed] = ((await (await request('/api/admin/testings', { headers: admin })).json()) as Array<{
        id: string;
        money: { fees: number; perUnitTotal: number };
      }>).filter((x) => x.id === testingId);
      // Alice's part, and the hidden part of both units sold.
      expect(listed?.money).toMatchObject({ fees: 1000, perUnitTotal: 400 });
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
      await db.delete(orderItems).where(inArray(orderItems.orderId, [alice.orderId, bob.orderId]));
      await db.delete(orders).where(inArray(orders.id, [alice.orderId, bob.orderId]));
      if (testingId) await db.delete(testings).where(eq(testings.id, testingId));
      await db.delete(products).where(inArray(products.id, [tested, ...(donationProductId ? [donationProductId] : [])]));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('lets people from outside join a testing, for free when the fee is 0', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'genmaicha-outside',
        title: 'Genmaicha',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const tested = own!.id;
    const buyer = { Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`, 'content-type': 'application/json' };
    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: buyer, body: JSON.stringify({ productId: tested, quantity: 1 }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: buyer,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId: bought } = (await placed.json()) as { orderId: string };
    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    const outside = { Authorization: `Bearer ${await authToken(555002001, 'Olga')}`, 'content-type': 'application/json' };
    let testingId = '';
    const made: string[] = [];
    let extraIds: string[] = [];
    try {
      const body = {
        productId: tested,
        variantId: null,
        lab: 'Lab',
        contribution: 0,
        perUnit: 0,
        feeMode: 'mandatory',
        donationHours: 2,
        allowExternal: true,
        extraEnabled: true,
        tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 1 }],
      };
      // No fee: the extra round needs its lowest cap set by hand.
      const bare = await request('/api/admin/testings', { method: 'POST', headers: admin, body: JSON.stringify(body) });
      expect(bare.status).toBe(400);
      const created = await request('/api/admin/testings', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ ...body, extraMin: 500 }),
      });
      expect(created.status).toBe(201);
      const testing = (await created.json()) as { id: string; donationProductId: string; extraProductId?: string };
      testingId = testing.id;
      extraIds = [testing.donationProductId].filter(Boolean);
      const seen = ((await (await request(`/api/products/${tested}/testings`, { headers: outside })).json()) as Array<{
        externalOpen: boolean;
        joined: boolean;
      }>)[0];
      expect(seen).toMatchObject({ externalOpen: true, joined: false });

      const join = (headers: Record<string, string>): Promise<Response> =>
        Promise.resolve(
          request(`/api/orders/external-testing/${testingId}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ volunteer: true, contactUsername: 'olga_test' }),
          }),
        );
      // Bought here: from that order instead.
      expect((await join(buyer)).status).toBe(409);
      const joined = await join(outside);
      expect(joined.status).toBe(201);
      const { orderId } = (await joined.json()) as { orderId: string };
      made.push(orderId);
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      // Free: in at once, nothing to pay nor send.
      expect(order).toMatchObject({ external: true, externalTestingId: testingId, status: 'paid', total: 0 });
      expect((await join(outside)).status).toBe(409);
      const after = ((await (await request(`/api/products/${tested}/testings`, { headers: outside })).json()) as Array<{
        joined: boolean;
        participants: number;
      }>)[0];
      expect(after).toMatchObject({ joined: true, participants: 1 });
      // Messages: those of the testing (from outside too) and its volunteers.
      const count = async (query: string): Promise<number> =>
        ((await (await request(`/api/admin/broadcasts/count?${query}`, { headers: admin })).json()) as { count: number })
          .count;
      expect(await count(`audience=testing&testingId=${testingId}`)).toBe(1);
      expect(await count(`audience=donors&testingId=${testingId}`)).toBe(1);
      expect((await request('/api/admin/broadcasts/count?audience=testing', { headers: admin })).status).toBe(400);
      // Offering a vial is per testing, and it can change until the draw.
      const offer = (volunteer: boolean): Promise<Response> =>
        Promise.resolve(
          request(`/api/orders/${orderId}/testings/${testingId}/volunteer`, {
            method: 'PUT',
            headers: outside,
            body: JSON.stringify({ volunteer }),
          }),
        );
      expect((await offer(false)).status).toBe(200);
      expect(await count(`audience=donors&testingId=${testingId}`)).toBe(0);
      const mineNow = ((await (await request(`/api/products/${tested}/testings`, { headers: outside })).json()) as Array<{
        volunteer: boolean;
      }>)[0];
      expect(mineNow?.volunteer).toBe(false);
      expect((await offer(true)).status).toBe(200);
      // In like anyone: they can give from that order.
      const gift = await request(`/api/orders/${orderId}/donations`, {
        method: 'POST',
        headers: outside,
        body: JSON.stringify({ testingId, amount: 1000 }),
      });
      expect(gift.status).toBe(200);
      // And it cannot be changed (no products).
      const change = await request(`/api/orders/${orderId}/change`, {
        method: 'POST',
        headers: outside,
        body: JSON.stringify({ items: [{ productId: tested, quantity: 1 }] }),
      });
      expect(change.status).toBeGreaterThanOrEqual(400);
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
      const all = [bought, ...made];
      await db.delete(orderItems).where(inArray(orderItems.orderId, all));
      await db.delete(testingEntries).where(inArray(testingEntries.orderId, all));
      await db.delete(orders).where(inArray(orders.id, all));
      const [row] = testingId ? await db.select().from(testings).where(eq(testings.id, testingId)) : [];
      if (testingId) await db.delete(testings).where(eq(testings.id, testingId));
      const extraProduct = row?.extraProductId ? [row.extraProductId] : [];
      await db.delete(products).where(inArray(products.id, [tested, ...extraIds, ...extraProduct]));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('reopens the time to join on a closed testing, and on one settled with nothing reached', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'bancha-reopen',
        title: 'Bancha',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const tested = own!.id;
    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    const made: string[] = [];
    const hidden: string[] = [];
    const body = {
      productId: tested,
      variantId: null,
      lab: 'Lab',
      contribution: 1000,
      perUnit: 0,
      feeMode: 'mandatory',
      donationHours: 2,
      tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 0 }],
    };
    const create = async (): Promise<string> => {
      const created = await request('/api/admin/testings', { method: 'POST', headers: admin, body: JSON.stringify(body) });
      expect(created.status).toBe(201);
      const x = (await created.json()) as { id: string; donationProductId: string | null };
      made.push(x.id);
      if (x.donationProductId) hidden.push(x.donationProductId);
      return x.id;
    };
    const state = async (id: string): Promise<{ status: string; donationsOpen: boolean }> =>
      ((await (await request('/api/admin/testings', { headers: admin })).json()) as Array<{
        id: string;
        status: string;
        donationsOpen: boolean;
      }>).find((x) => x.id === id)!;
    const reopen = (id: string): Promise<Response> =>
      Promise.resolve(
        request(`/api/admin/testings/${id}/reopen`, { method: 'POST', headers: admin, body: JSON.stringify({ hours: 5 }) }),
      );
    try {
      const id = await create();
      await closeDonationWindows(db, testEnv, new Date(Date.now() + 3 * 3600_000));
      expect(await state(id)).toMatchObject({ status: 'closed', donationsOpen: false });
      expect((await reopen(id)).status).toBe(200);
      expect(await state(id)).toMatchObject({ status: 'closed', donationsOpen: true });

      // Settled with nothing reached: it comes back, unless a newer testing of the product exists.
      await closeDonationWindows(db, testEnv, new Date(Date.now() + 6 * 3600_000));
      expect((await request(`/api/admin/testings/${id}/settle`, { method: 'POST', headers: admin })).status).toBe(200);
      expect((await state(id)).status).toBe('settled');
      const newer = await create();
      expect((await reopen(id)).status).toBe(409);
      await db.delete(testings).where(eq(testings.id, newer));
      expect((await reopen(id)).status).toBe(200);
      expect(await state(id)).toMatchObject({ status: 'closed', donationsOpen: true });

      // Reports are kept with their file: the organisers list and open them; others do not see them.
      await db.insert(testingReports).values({
        testingId: id,
        shopId,
        kind: 'base',
        fileKind: 'document',
        fileId: 'file-1',
        fileName: 'report.pdf',
        mime: 'application/pdf',
        data: Buffer.from('%PDF-1'),
        size: 6,
        delivered: 3,
      });
      const kept = (await (await request('/api/admin/testing-reports', { headers: admin })).json()) as Array<{
        id: string;
        testingId: string;
        hasCopy: boolean;
        delivered: number;
      }>;
      const mine = kept.find((r) => r.testingId === id);
      expect(mine).toMatchObject({ hasCopy: true, delivered: 3 });
      const file = await request(`/api/admin/testing-reports/${mine!.id}/file`, { headers: admin });
      expect(file.status).toBe(200);
      expect(await file.text()).toBe('%PDF-1');
      const stranger = { Authorization: `Bearer ${await authToken(555004001, 'Sol')}` };
      // (The GB is closed and they have nothing in it: they do not even reach it.)
      const theirs = await request('/api/products/testing-reports', { headers: stranger });
      expect(theirs.status === 404 || JSON.stringify(await theirs.json()) === '[]').toBe(true);
      expect((await request(`/api/products/testing-reports/${mine!.id}/file`, { headers: stranger })).status).toBe(404);
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
      if (made.length > 0) await db.delete(testings).where(inArray(testings.id, made));
      await db.delete(products).where(inArray(products.id, [tested, ...hidden]));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('hides the testing of a VIP-only product from those who are not VIPs', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'gyokuro-vip',
        title: 'Gyokuro',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
        vipOnly: true,
      })
      .returning();
    const made: string[] = [];
    try {
      const created = await request('/api/admin/testings', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          productId: own!.id,
          variantId: null,
          lab: 'Lab',
          contribution: 500,
          perUnit: 0,
          feeMode: 'mandatory',
          tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 1 }],
        }),
      });
      const testing = (await created.json()) as { id: string; donationProductId: string | null };
      made.push(testing.id);
      const ids = async (headers: Record<string, string>): Promise<string[]> =>
        ((await (await request('/api/products/testings', { headers })).json()) as Array<{ id: string }>).map((x) => x.id);
      const someone = { Authorization: `Bearer ${await authToken(555006001, 'Ivo')}` };
      expect(await ids(someone)).not.toContain(testing.id);
      expect(await ids(admin)).toContain(testing.id);
      if (testing.donationProductId) made.push(`p:${testing.donationProductId}`);
    } finally {
      const tids = made.filter((x) => !x.startsWith('p:'));
      if (tids.length > 0) await db.delete(testings).where(inArray(testings.id, tids));
      const pids = made.filter((x) => x.startsWith('p:')).map((x) => x.slice(2));
      await db.delete(products).where(inArray(products.id, [own!.id, ...pids]));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('keeps the GB\'s labs and their tests with prices', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const body = {
      name: 'Uzorak',
      currency: 'USDC',
      tests: [
        { id: 'mp', name: 'Mass and purity', cost: 15000, vials: 1 },
        { id: 'endo', name: 'Endotoxins', cost: 9000, vials: 1 },
      ],
      notes: null,
    };
    const created = await request('/api/admin/labs', { method: 'POST', headers: admin, body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const lab = (await created.json()) as { id: string };
    const listed = (await (await request('/api/admin/labs', { headers: admin })).json()) as Array<{
      id: string;
      tests: unknown[];
    }>;
    expect(listed.find((x) => x.id === lab.id)?.tests).toHaveLength(2);
    const changed = await request(`/api/admin/labs/${lab.id}`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ ...body, tests: body.tests.slice(0, 1) }),
    });
    expect(((await changed.json()) as { tests: unknown[] }).tests).toHaveLength(1);
    expect((await request(`/api/admin/labs/${lab.id}`, { method: 'DELETE', headers: admin })).status).toBe(200);
    expect((await request(`/api/admin/labs/${lab.id}`, { method: 'DELETE', headers: admin })).status).toBe(404);
  });

  it('lists what is owed back, with why, until it is marked as sent', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const headers = { Authorization: `Bearer ${await authToken(555005001, 'Rui')}`, 'content-type': 'application/json' };
    await db.delete(carts).where(eq(carts.userId, 555005001));
    await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId, quantity: 1 }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ contactUsername: '@rui_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    try {
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      await request(`/api/admin/orders/${orderId}`, {
        method: 'PATCH',
        headers: admin,
        body: JSON.stringify({ status: 'cancelled' }),
      });
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
      const owed = (await (await request('/api/admin/refunds', { headers: admin })).json()) as Array<{
        orderId: string;
        amount: number;
        reasons: string[];
      }>;
      expect(owed.find((r) => r.orderId === orderId)).toMatchObject({
        amount: order!.amountPaid,
        reasons: ['cancelled'],
      });
      expect((await request(`/api/admin/orders/${orderId}/refund`, { method: 'POST', headers: admin })).status).toBe(200);
      const after = (await (await request('/api/admin/refunds', { headers: admin })).json()) as Array<{ orderId: string }>;
      expect(after.some((r) => r.orderId === orderId)).toBe(false);
    } finally {
      await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await db.delete(orders).where(eq(orders.id, orderId));
    }
  });

  it('runs the extra round: equal shares within caps, only for the tests still missing', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'kukicha-extra',
        title: 'Kukicha',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const tested = own!.id;
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId: tested,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'mandatory',
        donationHours: 1,
        extraEnabled: true,
        extraMin: 0,
        extraSignupHours: 24,
        tiers: [
          { id: 'mp', name: 'M&P', cost: 1000, vials: 0 },
          { id: 'endo', name: 'Endo', cost: 6000, vials: 0 },
        ],
      }),
    });
    const testing = (await created.json()) as { id: string; donationProductId: string };
    const testingId = testing.id;
    const [row0] = await db.select().from(testings).where(eq(testings.id, testingId));
    const people: Array<{ orderId: string; headers: Record<string, string> }> = [];
    for (const [userId, name] of [
      [CUSTOMER_ID, 'Alice'],
      [555001001, 'Ann'],
      [555001002, 'Cid'],
    ] as const) {
      const headers = { Authorization: `Bearer ${await authToken(userId, name)}`, 'content-type': 'application/json' };
      await db.delete(carts).where(eq(carts.userId, userId));
      await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId: tested, quantity: 1 }) });
      const placed = await request('/api/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ contactUsername: `@${name.toLowerCase()}_test` }),
      });
      const { orderId } = (await placed.json()) as { orderId: string };
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      people.push({ orderId, headers });
    }
    const [a, b, c] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0]];
    const signUp = (who: typeof a, cap: number): Promise<Response> =>
      Promise.resolve(
        request(`/api/orders/${who.orderId}/extra`, {
          method: 'POST',
          headers: who.headers,
          body: JSON.stringify({ testingId, cap }),
        }),
      );
    const t0 = Date.now();
    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    try {
      // Fees 30: M&P is covered, 40 missing for Endo. One can sign up early, before it opens.
      expect((await signUp(a, 2000)).status).toBe(200);
      const early = ((await (await request(`/api/products/${tested}/testings`, { headers: a.headers })).json()) as Array<{
        extra: unknown;
        extraPre: { stage: string; mine: { cap: number } | null } | null;
      }>)[0];
      expect(early).toMatchObject({ extra: null, extraPre: { stage: 'pre', mine: { cap: 2000 } } });
      await db.update(testings).set({ status: 'closed' }).where(eq(testings.id, testingId));
      const shopRow = (await db.query.shops.findFirst({ where: eq(shops.id, shopId) }))!;
      await openDonationWindows(db, testEnv, shopRow, new Date(t0));
      await closeDonationWindows(db, testEnv, new Date(t0 + 2 * 3600_000));
      const [started] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(started?.extra).toMatchObject({ stage: 'signup' });
      // Signed up early: in already.
      const kept = await db.select().from(testingExtraMembers).where(eq(testingExtraMembers.testingId, testingId));
      expect(kept.map((m) => [m.orderId, m.cap])).toEqual([[a.orderId, 2000]]);

      // The cap must be at least the fee.
      expect((await signUp(a, 500)).status).toBe(400);
      expect((await signUp(a, 2000)).status).toBe(200);
      expect((await signUp(b, 2000)).status).toBe(200);
      expect((await signUp(c, 1000)).status).toBe(200);
      const seen = ((await (await request(`/api/products/${tested}/testings`, { headers: a.headers })).json()) as Array<{
        extra: { missing: Array<{ amount: number }>; estimate: { share: number | null; out: boolean } };
      }>)[0];
      // 40 among three would be 13.34: above Cid's cap, so the other two pay 20 each.
      expect(seen?.extra.missing).toEqual([expect.objectContaining({ amount: 4000 })]);
      expect(seen?.extra.estimate).toMatchObject({ share: 2000, out: false });

      await advanceExtras(db, testEnv, new Date(t0 + 28 * 3600_000));
      const members = await db.select().from(testingExtraMembers).where(eq(testingExtraMembers.testingId, testingId));
      expect(members.map((m) => [m.orderId, m.state, m.share]).sort()).toEqual(
        [
          [a.orderId, 'in', 2000],
          [b.orderId, 'in', 2000],
          [c.orderId, 'out', 0],
        ].sort(),
      );
      const [aOrder] = await db.select().from(orders).where(eq(orders.id, a.orderId));
      expect(aOrder).toMatchObject({ status: 'pending' });
      expect((aOrder?.total ?? 0) - (aOrder?.amountPaid ?? 0)).toBe(2000);

      for (const who of [a, b]) {
        await request(`/api/admin/orders/${who.orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      }
      await advanceExtras(db, testEnv, new Date(t0 + 80 * 3600_000));
      const [done] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(done?.extra).toMatchObject({ stage: 'done', outcome: { tiers: ['endo'], collected: 4000, refunded: 0 } });
      const status = await request(`/api/admin/testings/${testingId}/draw`, { headers: admin });
      expect(await status.json()).toEqual({ blocker: null });
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
      const ids = people.map((p) => p.orderId);
      await db.delete(orderItems).where(inArray(orderItems.orderId, ids));
      await db.delete(orders).where(inArray(orders.id, ids));
      await db.delete(testings).where(eq(testings.id, testingId));
      await db
        .delete(products)
        .where(inArray(products.id, [tested, testing.donationProductId, ...(row0?.extraProductId ? [row0.extraProductId] : [])]));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('shares the extra round out as soon as the time to give ends when it has no sign-up of its own', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'kukicha-unified',
        title: 'Kukicha',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const tested = own!.id;
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId: tested,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'mandatory',
        donationHours: 1,
        extraEnabled: true,
        extraMin: 0,
        extraSignupHours: 0,
        tiers: [
          { id: 'mp', name: 'M&P', cost: 1000, vials: 0 },
          { id: 'endo', name: 'Endo', cost: 6000, vials: 0 },
        ],
      }),
    });
    const testing = (await created.json()) as { id: string; donationProductId: string };
    const testingId = testing.id;
    const [row0] = await db.select().from(testings).where(eq(testings.id, testingId));
    const people: Array<{ orderId: string; headers: Record<string, string> }> = [];
    for (const [userId, name] of [
      [555003001, 'Uma'],
      [555003002, 'Ugo'],
      [555003003, 'Ula'],
    ] as const) {
      const headers = { Authorization: `Bearer ${await authToken(userId, name)}`, 'content-type': 'application/json' };
      await db.delete(carts).where(eq(carts.userId, userId));
      await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId: tested, quantity: 1 }) });
      const placed = await request('/api/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ contactUsername: `@${name.toLowerCase()}_test` }),
      });
      const { orderId } = (await placed.json()) as { orderId: string };
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      people.push({ orderId, headers });
    }
    const [a, b, c] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0]];
    const signUp = (who: typeof a, cap: number): Promise<Response> =>
      Promise.resolve(
        request(`/api/orders/${who.orderId}/extra`, {
          method: 'POST',
          headers: who.headers,
          body: JSON.stringify({ testingId, cap }),
        }),
      );
    const t0 = Date.now();
    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    try {
      // Caps set during the time to give; when it ends it is shared out at once.
      expect((await signUp(a, 2000)).status).toBe(200);
      expect((await signUp(b, 2000)).status).toBe(200);
      expect((await signUp(c, 1000)).status).toBe(200);
      await db.update(testings).set({ status: 'closed' }).where(eq(testings.id, testingId));
      const shopRow = (await db.query.shops.findFirst({ where: eq(shops.id, shopId) }))!;
      await openDonationWindows(db, testEnv, shopRow, new Date(t0));
      await closeDonationWindows(db, testEnv, new Date(t0 + 2 * 3600_000));
      const [started] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(started?.extra).toMatchObject({ stage: 'pay', share: 2000 });
      const members = await db.select().from(testingExtraMembers).where(eq(testingExtraMembers.testingId, testingId));
      expect(members.map((m) => [m.orderId, m.state, m.share]).sort()).toEqual(
        [
          [a.orderId, 'in', 2000],
          [b.orderId, 'in', 2000],
          [c.orderId, 'out', 0],
        ].sort(),
      );
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
      const ids = people.map((p) => p.orderId);
      await db.delete(orderItems).where(inArray(orderItems.orderId, ids));
      await db.delete(orders).where(inArray(orders.id, ids));
      await db.delete(testings).where(eq(testings.id, testingId));
      await db
        .delete(products)
        .where(inArray(products.id, [tested, testing.donationProductId, ...(row0?.extraProductId ? [row0.extraProductId] : [])]));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('asks the payers whether they go on when someone does not pay the extra round', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const [seed] = await db.select().from(products).where(eq(products.id, productId));
    const [own] = await db
      .insert(products)
      .values({
        shopId,
        categoryId: seed!.categoryId,
        slug: 'kukicha-round',
        title: 'Kukicha',
        description: '',
        price: 150,
        currency: 'USDC',
        stock: 10,
        isActive: true,
      })
      .returning();
    const tested = own!.id;
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId: tested,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'mandatory',
        donationHours: 1,
        extraEnabled: true,
        extraMin: 0,
        extraSignupHours: 24,
        tiers: [
          { id: 'mp', name: 'M&P', cost: 1000, vials: 0 },
          { id: 'endo', name: 'Endo', cost: 6000, vials: 0 },
        ],
      }),
    });
    const testing = (await created.json()) as { id: string; donationProductId: string };
    const testingId = testing.id;
    const [row0] = await db.select().from(testings).where(eq(testings.id, testingId));
    const people: Array<{ orderId: string; headers: Record<string, string> }> = [];
    for (const [userId, name] of [
      [555001003, 'Bea'],
      [555001004, 'Dan'],
      [555001005, 'Eva'],
    ] as const) {
      const headers = { Authorization: `Bearer ${await authToken(userId, name)}`, 'content-type': 'application/json' };
      await db.delete(carts).where(eq(carts.userId, userId));
      await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId: tested, quantity: 1 }) });
      const placed = await request('/api/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ contactUsername: `@${name.toLowerCase()}_test` }),
      });
      const { orderId } = (await placed.json()) as { orderId: string };
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      people.push({ orderId, headers });
    }
    const [a, b, c] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0]];
    const signUp = (who: typeof a, cap: number): Promise<Response> =>
      Promise.resolve(
        request(`/api/orders/${who.orderId}/extra`, {
          method: 'POST',
          headers: who.headers,
          body: JSON.stringify({ testingId, cap }),
        }),
      );
    const t0 = Date.now();
    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    try {
      await db.update(testings).set({ status: 'closed' }).where(eq(testings.id, testingId));
      const shopRow = (await db.query.shops.findFirst({ where: eq(shops.id, shopId) }))!;
      await openDonationWindows(db, testEnv, shopRow, new Date(t0));
      await closeDonationWindows(db, testEnv, new Date(t0 + 2 * 3600_000));
      // 40 missing for Endo, three in: 13.34, 13.33 and 13.33.
      expect((await signUp(a, 3000)).status).toBe(200);
      expect((await signUp(b, 2900)).status).toBe(200);
      expect((await signUp(c, 2800)).status).toBe(200);
      await advanceExtras(db, testEnv, new Date(t0 + 28 * 3600_000));
      for (const who of [a, b]) {
        await request(`/api/admin/orders/${who.orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      }
      // Cid does not pay: 13.33 is missing, and the two who paid are asked.
      await advanceExtras(db, testEnv, new Date(t0 + 80 * 3600_000));
      const [round] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(round?.extra).toMatchObject({ stage: 'round', gap: 1333 });
      const seen = ((await (await request(`/api/products/${tested}/testings`, { headers: a.headers })).json()) as Array<{
        extra: { round: { gap: number; options: Array<{ count: number; amount: number }> } | null };
      }>)[0];
      expect(seen?.extra.round).toEqual({
        gap: 1333,
        options: [
          { count: 2, amount: 667 },
          { count: 1, amount: 1333 },
        ],
      });
      const answer = (who: typeof a, stay: boolean): Promise<Response> =>
        Promise.resolve(
          request(`/api/orders/${who.orderId}/extra/round`, {
            method: 'POST',
            headers: who.headers,
            body: JSON.stringify({ testingId, stay }),
          }),
        );
      // Only those who paid are asked.
      expect((await answer(c, true)).status).toBe(409);
      expect((await answer(a, true)).status).toBe(200);
      expect((await answer(b, true)).status).toBe(200);

      // Both go on: 6.67 and 6.66 more, within their caps.
      await advanceExtras(db, testEnv, new Date(t0 + 105 * 3600_000));
      const topping = await db.select().from(testingExtraMembers).where(eq(testingExtraMembers.testingId, testingId));
      expect(topping.filter((m) => m.state === 'topup').map((m) => m.share).sort()).toEqual([2000, 2000]);
      const [owed] = await db.select().from(orders).where(eq(orders.id, b.orderId));
      expect((owed?.total ?? 0) - (owed?.amountPaid ?? 0)).toBeGreaterThan(0);
      for (const who of [a, b]) {
        await request(`/api/admin/orders/${who.orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      }
      await advanceExtras(db, testEnv, new Date(t0 + 130 * 3600_000));
      const [done] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(done?.extra).toMatchObject({ stage: 'done', outcome: { tiers: ['endo'], collected: 4000, refunded: 0 } });
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
      const ids = people.map((p) => p.orderId);
      await db.delete(orderItems).where(inArray(orderItems.orderId, ids));
      await db.delete(orders).where(inArray(orders.id, ids));
      await db.delete(testings).where(eq(testings.id, testingId));
      await db
        .delete(products)
        .where(inArray(products.id, [tested, testing.donationProductId, ...(row0?.extraProductId ? [row0.extraProductId] : [])]));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('closes a drawn testing: the donor gets the vial back, the fees stay', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'mandatory',
        tiers: [{ id: 'mp', name: 'M&P', cost: 600, vials: 1 }],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };
    // Mandatory: the fee comes with the product; Alice also offers a vial.
    const join = async (userId: number, name: string, volunteer: boolean): Promise<string> => {
      const headers = { Authorization: `Bearer ${await authToken(userId, name)}`, 'content-type': 'application/json' };
      await db.delete(carts).where(eq(carts.userId, userId));
      await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId, quantity: 1 }) });
      if (volunteer) {
        await request('/api/cart/testings', { method: 'POST', headers, body: JSON.stringify({ testingId, volunteer }) });
      }
      const placed = await request('/api/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ contactUsername: `@${name.toLowerCase()}_test` }),
      });
      const { orderId } = (await placed.json()) as { orderId: string };
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      return orderId;
    };
    const volunteer = await join(CUSTOMER_ID, 'Alice', true);
    const other = await join(555000888, 'Eve', false);
    const [fee] = await db.select().from(orders).where(eq(orders.id, other));
    expect(fee?.testing).toBe(1000);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, volunteer));

    await db.update(shops).set({ closedAt: new Date() }).where(eq(shops.id, shopId));
    try {
      await db.update(testings).set({ status: 'closed' }).where(eq(testings.id, testingId));
      const hash = 'cd'.repeat(32);
      const explorer = (async (url: string | URL | Request) =>
        new Response(String(url).endsWith('/blocks/tip/height') ? '900000' : hash)) as unknown as typeof fetch;
      const shopRow = (await db.query.shops.findFirst({ where: eq(shops.id, shopId) }))!;
      const launched = await launchDraw(db, testEnv, shopRow, testingId, explorer);
      await finishDraw(db, testEnv, launched, explorer);
      const [drawn] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(drawn?.draw).toMatchObject({ donors: [volunteer.slice(0, 8)], tiersDone: ['mp'] });

      expect((await request(`/api/admin/testings/${testingId}/settle`, { method: 'POST', headers: admin })).status).toBe(200);
      const rows = await db.select().from(orders).where(inArray(orders.id, [volunteer, other]));
      const due = (id: string): number => {
        const o = rows.find((r) => r.id === id)!;
        return o.total - o.amountPaid;
      };
      // The donor gets the price of the vial back (a tenth of the unit); the other keeps the fee paid.
      expect(due(volunteer)).toBe(-Math.round(item!.unitPrice / 10));
      expect(due(other)).toBe(0);
      const [settled] = await db.select().from(testings).where(eq(testings.id, testingId));
      expect(settled?.status).toBe('settled');
      // A GB with a settled testing cannot be opened again.
      expect((await request('/api/admin/shop/reopen', { method: 'POST', headers: admin })).status).toBe(409);
    } finally {
      await db.update(shops).set({ closedAt: null }).where(eq(shops.id, shopId));
    }
    await db.delete(orderItems).where(inArray(orderItems.orderId, [volunteer, other]));
    await db.delete(orders).where(inArray(orders.id, [volunteer, other]));
    await db.delete(testings).where(eq(testings.id, testingId));
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
  });

  it('exempts VIPs from a fee mandatory for the rest', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab',
        contribution: 700,
        perUnit: 0,
        feeMode: 'mandatory_non_vip',
        tiers: [{ id: 'mp', name: 'M&P', cost: 600, vials: 1 }],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };
    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 1 }) });
    const cartOf = async () =>
      (await (await request('/api/cart', { headers: auth })).json()) as { testings: Array<{ amount: number; mandatory: boolean }> };
    // Not VIP: the fee is there and cannot be left out.
    expect((await cartOf()).testings).toEqual([expect.objectContaining({ amount: 700, mandatory: true })]);
    // As a VIP: no fee (only a vial offer would add the testing, at 0).
    const [shopRow] = await db.select().from(shops).where(eq(shops.id, shopId));
    await db
      .update(shops)
      .set({ vipClub: { ...shopRow!.vipClub, userIds: [CUSTOMER_ID] } })
      .where(eq(shops.id, shopId));
    resetVipCache();
    try {
      const vipAuth = {
        Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
        'content-type': 'application/json',
      };
      const vipCart = (await (await request('/api/cart', { headers: vipAuth })).json()) as { testings: unknown[] };
      expect(vipCart.testings).toEqual([]);
      const listed = (await (await request(`/api/products/${productId}/testings`, { headers: vipAuth })).json()) as Array<{
        exempt: boolean;
      }>;
      expect(listed[0]?.exempt).toBe(true);
    } finally {
      await db.update(shops).set({ vipClub: shopRow!.vipClub }).where(eq(shops.id, shopId));
      resetVipCache();
      await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
      await db.delete(testings).where(eq(testings.id, testingId));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('cancels a testing: what was paid for it goes back', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'optional',
        tiers: [{ id: 'mp', name: 'M&P', cost: 600, vials: 1 }],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };
    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 1 }) });
    await request('/api/cart/testings', { method: 'POST', headers: auth, body: JSON.stringify({ testingId, volunteer: false }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });

    expect((await request(`/api/admin/testings/${testingId}/cancel`, { method: 'POST', headers: admin })).status).toBe(200);
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row).toMatchObject({ testing: 0 });
    expect((row?.total ?? 0) - (row?.amountPaid ?? 0)).toBe(-1000);
    // Finished: the switch can be turned off.
    expect(
      (await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) })).status,
    ).toBe(200);

    await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await db.delete(orders).where(eq(orders.id, orderId));
    await db.delete(testings).where(eq(testings.id, testingId));
    await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
  });

  it('a paid order that joins a testing owes only its part, and is paid again if the testing goes', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab',
        contribution: 1000,
        perUnit: 0,
        feeMode: 'optional',
        tiers: [{ id: 'mp', name: 'M&P', cost: 600, vials: 1 }],
      }),
    });
    const { id: testingId } = (await created.json()) as { id: string };
    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 1 }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    try {
      await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
      const joined = await request(`/api/orders/${orderId}/testings`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ testingId, volunteer: false }),
      });
      expect(joined.status).toBeLessThan(300);
      // Only the testing's part is owed: the products are paid.
      const owing = (await (await request(`/api/admin/orders/${orderId}`, { headers: admin })).json()) as {
        status: string;
        productsPaid: boolean;
        amountDue: number;
      };
      expect(owing).toMatchObject({ status: 'pending', productsPaid: true, amountDue: 1000 });
      // The testing goes before it is paid: the order is paid again, not left with a "difference".
      expect((await request(`/api/admin/testings/${testingId}/cancel`, { method: 'POST', headers: admin })).status).toBe(200);
      const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(row).toMatchObject({ status: 'paid', testing: 0 });
      expect((row?.total ?? 0) - (row?.amountPaid ?? 0)).toBe(0);
    } finally {
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
      await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await db.delete(orders).where(eq(orders.id, orderId));
      await db.delete(testings).where(eq(testings.id, testingId));
      await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
    }
  });

  it('keeps the active bot in the database, and takes a new BOT_TOKEN put in .env by hand', async () => {
    await db.delete(botSwitches);
    await db.delete(bots);
    await db.delete(botSettings);
    const offline = { getMe: () => Promise.reject(new Error('offline')) } as unknown as TelegramApi;
    const works = (id: number) =>
      ({ getMe: async () => ({ id, username: `bot${id}`, first_name: 'GB' }) }) as unknown as TelegramApi;
    try {
      // First start: BOT_TOKEN becomes the active bot, stored encrypted.
      await loadActiveBot(db, testEnv, offline);
      const [first] = await db.select().from(bots);
      expect(first).toMatchObject({ id: Number(BOT_TOKEN.split(':')[0]), status: 'active' });
      expect(first?.token).not.toContain(BOT_TOKEN);
      expect(openSecret(secretKey(testEnv), first!.token)).toBe(BOT_TOKEN);
      expect(botToken(testEnv)).toBe(BOT_TOKEN);

      // A token changed in .env that Telegram refuses never takes over.
      const dead = { ...testEnv, BOT_TOKEN: '999000222:DeadBotTokenForTests_abcdefghijklmno' };
      await loadActiveBot(db, dead, offline);
      expect(botToken(testEnv)).toBe(BOT_TOKEN);

      // Another token in .env that works: it takes over, the previous one is kept as down.
      const other = { ...testEnv, BOT_TOKEN: '999000111:OtherBotTokenForTests_abcdefghijklmn' };
      await loadActiveBot(db, other, works(999000111));
      const rows = await db.select().from(bots);
      expect(rows.find((r) => r.id === 999000111)?.status).toBe('active');
      expect(rows.find((r) => r.id === first!.id)?.status).toBe('down');
      expect(botToken(testEnv)).toBe(other.BOT_TOKEN);

      // Same .env again after the panel switched (and the .env bot was forgotten): the stored one stays.
      await db.delete(bots).where(eq(bots.id, 999000111));
      await db.update(bots).set({ status: 'active' }).where(eq(bots.id, first!.id));
      await loadActiveBot(db, other, works(999000111));
      expect(botToken(testEnv)).toBe(BOT_TOKEN);

      // No BOT_TOKEN in .env at all: the stored active bot.
      useBot(null);
      await loadActiveBot(db, { ...testEnv, BOT_TOKEN: undefined }, offline);
      expect(botToken({ BOT_TOKEN: undefined })).toBe(BOT_TOKEN);
    } finally {
      useBot(null);
      await db.delete(botSwitches);
      await db.delete(bots);
      await db.delete(botSettings);
    }
  });

  it('switches to another bot from the panel and keeps the old one as down', async () => {
    await db.delete(botSwitches);
    await db.delete(bots);
    const offline = { getMe: () => Promise.reject(new Error('offline')) } as unknown as TelegramApi;
    const NEW = '888000222:NewBotTokenForIntegrationTests_abcdef';
    const calls: string[] = [];
    const fake = (token: string): TelegramApi =>
      ({
        getMe: async () => {
          if (token !== NEW) throw new Error('closed');
          return { id: 888000222, username: 'gb_new_bot', first_name: 'GB' };
        },
        setWebhook: async () => {
          calls.push('webhook');
          return true;
        },
        getChatMenuButton: async () => ({ type: 'default' }),
        setChatMenuButton: async (_text: string, url: string) => {
          calls.push(`menu ${url}`);
          return true;
        },
        getProfile: async () => {
          throw new Error('closed');
        },
        sendMessage: async () => ({ message_id: 1 }),
      }) as unknown as TelegramApi;
    try {
      await loadActiveBot(db, testEnv, offline);
      const admin = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`, 'content-type': 'application/json' };
      // A token Telegram does not accept is refused before anything changes.
      const bad = await request('/api/platform/bots/switch', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ token: 'not-a-token' }),
      });
      expect(bad.status).toBe(400);

      const info = await switchBot(db, { ...testEnv, PUBLIC_URL: 'https://gb.example' }, NEW, 'manual', ADMIN_ID, fake);
      expect(info).toMatchObject({ id: 888000222, username: 'gb_new_bot', status: 'active' });
      expect(calls).toEqual(['webhook', 'menu https://gb.example/']);
      expect(botToken(testEnv)).toBe(NEW);
      await expect(switchBot(db, testEnv, NEW, 'manual', ADMIN_ID, fake)).rejects.toMatchObject({ code: 'bot_same' });

      const overview = (await (await request('/api/platform/bots', { headers: admin })).json()) as {
        active: { id: number };
        bots: Array<{ id: number; status: string }>;
        history: Array<{ reason: string; to: { username: string } }>;
      };
      expect(overview.active.id).toBe(888000222);
      expect(overview.bots).toEqual([expect.objectContaining({ id: Number(BOT_TOKEN.split(':')[0]), status: 'down' })]);
      expect(overview.history[0]).toMatchObject({ reason: 'manual', to: { username: 'gb_new_bot' } });
    } finally {
      useBot(null);
      await db.delete(botSwitches);
      await db.delete(bots);
    }
  });

  it('signs a creator account in (code, then password) and notices when Telegram asks again', async () => {
    await db.delete(creatorAccounts);
    let meFails = false;
    const fake: CreatorApi = {
      loginStart: async () => ({ loginId: 'L1', viaApp: true }),
      loginCode: async (_id, code) => {
        if (code !== '12345') throw new CreatorError('PHONE_CODE_INVALID');
        return { password: true, hint: 'pet' };
      },
      loginPassword: async () => ({ done: true, session: 'SESSION-STRING', user: { id: 4242, username: 'gb_maker', firstName: 'Maker' } }),
      me: async () => {
        if (meFails) throw new CreatorError('AUTH_KEY_UNREGISTERED');
        return { user: { id: 4242, username: 'gb_maker', firstName: 'Maker' } };
      },
      call: async () => {
        throw new Error('not used');
      },
    };
    try {
      const first = await addCreatorAccount(db, testEnv, { phone: '+34600111222', apiId: 123, apiHash: 'a'.repeat(32) }, fake);
      expect(first).toMatchObject({ step: 'code', viaApp: true });
      await expect(submitCreatorCode(db, testEnv, first.id, '00000', fake)).rejects.toMatchObject({ code: 'creator_code' });
      expect(await submitCreatorCode(db, testEnv, first.id, '12345', fake)).toMatchObject({ step: 'password', hint: 'pet' });
      expect(await submitCreatorPassword(db, testEnv, first.id, 'secret', fake)).toMatchObject({ step: 'done' });

      const [row] = await db.select().from(creatorAccounts);
      expect(row?.session).not.toContain('SESSION-STRING');
      expect(row?.apiHash).not.toContain('aaaa');
      expect(await listCreatorAccounts(db)).toEqual([
        expect.objectContaining({ status: 'ok', username: 'gb_maker', telegramId: 4242, phone: '•••222' }),
      ]);
      // The same number twice is refused.
      await expect(
        addCreatorAccount(db, testEnv, { phone: '+34600111222', apiId: 123, apiHash: 'a'.repeat(32) }, fake),
      ).rejects.toMatchObject({ code: 'creator_exists' });

      // Telegram no longer takes the session: it has to sign in again.
      meFails = true;
      await checkCreatorAccounts(db, testEnv, fake);
      expect((await listCreatorAccounts(db))[0]).toMatchObject({ status: 'login', lastError: 'AUTH_KEY_UNREGISTERED' });

      await removeCreatorAccount(db, first.id);
      expect(await listCreatorAccounts(db)).toEqual([]);
    } finally {
      await db.delete(creatorAccounts);
    }
  });

  it('creates a spare bot with a creator account, keeps the pace and takes it out', async () => {
    await db.delete(botSwitches);
    await db.delete(bots);
    await db.delete(creatorAccounts);
    await db.delete(botSettings);
    const SPARE = '777000333:SpareBotTokenForIntegrationTests_abcd';
    const calls: string[] = [];
    let taken = true;
    const fake: CreatorApi = {
      loginStart: async () => ({ loginId: 'x', viaApp: false }),
      loginCode: async () => ({ password: true, hint: null }),
      loginPassword: async () => {
        throw new Error('not used');
      },
      me: async () => ({ user: { id: 1, username: null, firstName: null } }),
      call: async <T,>(path: string, body: Record<string, unknown>): Promise<T> => {
        calls.push(`${path} ${String(body.username ?? '')}`);
        if (path === '/botfather/newbot') {
          if (taken) {
            taken = false;
            throw new CreatorError('USERNAME_TAKEN');
          }
          return { token: SPARE } as T;
        }
        return { ok: true } as T;
      },
    };
    const telegramFor = (token: string): TelegramApi =>
      ({
        getMe: async () => ({ id: 777000333, username: 'gb_spare_bot', first_name: 'GB' }),
        getProfile: async () => ({ name: 'GB', description: '', shortDescription: '' }),
        setProfile: async () => {
          calls.push(`profile ${token === SPARE ? 'spare' : 'active'}`);
        },
        getMyCommands: async () => [{ command: 'start', description: 'Start' }],
        setMyCommands: async () => true,
        getChatMenuButton: async () => ({ type: 'web_app', text: 'Open', web_app: { url: 'https://gb.example/' } }),
        setChatMenuButton: async () => true,
      }) as unknown as TelegramApi;
    try {
      const key = secretKey(testEnv);
      await db.insert(creatorAccounts).values({
        phone: '+34600999888',
        apiId: 1,
        apiHash: seal(key, 'b'.repeat(32)),
        session: seal(key, 'SESSION'),
        status: 'ok',
      });
      await db.insert(botSettings).values({ id: 1, usernamePrefix: 'gbtest', photo: 'AAAA' });

      const spare = await createReserve(db, testEnv, fake, telegramFor);
      expect(spare).toMatchObject({ id: 777000333, status: 'reserve' });
      expect(spare.accountId).not.toBeNull();
      // The first @ was taken: another one was tried; then the photo went through @BotFather.
      expect(calls.filter((c) => c.startsWith('/botfather/newbot'))).toHaveLength(2);
      expect(calls.filter((c) => c.startsWith('/botfather/newbot'))[1]).toMatch(/^\/botfather\/newbot gbtest_[0-9a-f]{4}_bot$/);
      expect(calls).toContain('/botfather/setuserpic gb_spare_bot');
      expect(calls.filter((c) => c === 'profile spare')).toHaveLength(5);

      // Two wanted, but the last one is too recent: none is created now.
      expect(await keepReserve(db, testEnv, fake, new Date(), telegramFor)).toBeNull();

      await retireBot(db, testEnv, 777000333, fake);
      expect(calls).toContain('/botfather/deletebot gb_spare_bot');
      expect(await db.select().from(bots).where(eq(bots.id, 777000333))).toEqual([]);
    } finally {
      await db.delete(bots);
      await db.delete(creatorAccounts);
      await db.delete(botSettings);
    }
  });

  it('watches the active bot: three refusals in a row with no spare tell the administrators once', async () => {
    await db.delete(botSwitches);
    await db.delete(bots);
    await db.delete(botSettings);
    await db.delete(creatorAccounts);
    resetWatch();
    const before = (await db.select().from(webNotices)).length;
    const closed = {
      getMe: async () => {
        throw new TelegramError('Telegram getMe failed: Unauthorized', 401);
      },
    } as unknown as TelegramApi;
    const noCreator: CreatorApi = {
      loginStart: async () => ({ loginId: 'x', viaApp: false }),
      loginCode: async () => ({ password: true, hint: null }),
      loginPassword: async () => {
        throw new Error('not used');
      },
      me: async () => ({ user: { id: 1, username: null, firstName: null } }),
      call: async () => {
        throw new Error('not used');
      },
    };
    try {
      useBot({ id: 7654321, username: 'gb_test_bot', token: BOT_TOKEN });
      const t0 = new Date('2026-11-10T10:00:00Z');
      for (let i = 0; i < 4; i++) {
        await watchBot(db, testEnv, new Date(t0.getTime() + i * 60_000), noCreator, closed);
      }
      expect(watchStatus().problem).toContain('Unauthorized');
      // Told once, not on every check.
      expect((await db.select().from(webNotices)).length).toBe(before + 1);

      // Back to normal: a check that works clears the problem.
      const fine = { getMe: async () => ({ id: 7654321, first_name: 'GB' }) } as unknown as TelegramApi;
      await watchBot(db, testEnv, new Date(t0.getTime() + 10 * 60_000), noCreator, fine);
      expect(watchStatus().problem).toBeNull();
    } finally {
      resetWatch();
      useBot(null);
      await db.delete(botSettings);
    }
  });

  it('announces a new bot: privately to the admins, in the channel and in the groups', async () => {
    await db.delete(botSwitches);
    await db.delete(creatorAccounts);
    await db.delete(botSettings);
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fake: CreatorApi = {
      loginStart: async () => ({ loginId: 'x', viaApp: false }),
      loginCode: async () => ({ password: true, hint: null }),
      loginPassword: async () => {
        throw new Error('not used');
      },
      me: async () => ({ user: { id: 1, username: null, firstName: null } }),
      call: async <T,>(path: string, body: Record<string, unknown>): Promise<T> => {
        calls.push({ path, body });
        if (path === '/group/addbot') throw new CreatorError('CHAT_NOT_JOINED');
        return { ok: true, botAdmin: true } as T;
      },
    };
    const [shopBefore] = await db.select().from(shops).where(eq(shops.id, shopId));
    try {
      const key = secretKey(testEnv);
      await db.insert(creatorAccounts).values({
        phone: '+34600777666',
        apiId: 1,
        apiHash: seal(key, 'c'.repeat(32)),
        session: seal(key, 'SESSION'),
        status: 'ok',
      });
      await db.insert(botSettings).values({ id: 1, noticesChannel: '@gb_notices', noticeText: 'Bot: {bot}' });
      await db
        .update(shops)
        .set({ vipClub: { groups: [{ chatId: -1001234567, title: 'VIP' }], userIds: [], usernames: [] } })
        .where(eq(shops.id, shopId));
      await db.insert(botSwitches).values({ toBotId: 1, reason: 'closed' });

      const notices = await announceSwitch(db, testEnv, 'gb_new_bot', 'closed', fake);
      expect(notices).toEqual({
        admins: { sent: 1, failed: 0 },
        channel: { ok: true, botAdmin: true },
        groups: { ok: 0, failed: 1 },
      });
      expect(calls.find((c) => c.path === '/dm')?.body).toMatchObject({ to: ADMIN_ID });
      expect(calls.find((c) => c.path === '/channel/announce')?.body).toMatchObject({
        channel: '@gb_notices',
        text: 'Bot: @gb_new_bot',
        bot: '@gb_new_bot',
      });
      const [settings] = await db.select().from(botSettings);
      expect(settings?.groupStatus['-1001234567']).toMatchObject({ ok: false, error: 'CHAT_NOT_JOINED' });
      const [entry] = await db.select().from(botSwitches);
      expect(entry?.notices).toEqual(notices);
    } finally {
      await db.update(shops).set({ vipClub: shopBefore!.vipClub }).where(eq(shops.id, shopId));
      await db.delete(botSwitches);
      await db.delete(creatorAccounts);
      await db.delete(botSettings);
    }
  });

  it('asks for a security phrase before the first order, and keeps it encrypted', async () => {
    const userId = 555000999;
    const headers = {
      Authorization: `Bearer ${await authToken(userId, 'Phrase', undefined, { withPhrase: false })}`,
      'content-type': 'application/json',
    };
    await db.update(users).set({ securityPhrase: null }).where(eq(users.telegramId, userId));
    await db.delete(carts).where(eq(carts.userId, userId));
    await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId, quantity: 1 }) });
    const place = () =>
      request('/api/orders', { method: 'POST', headers, body: JSON.stringify({ contactUsername: '@phrase_test' }) });

    const refused = await place();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'security_phrase' } });
    expect(await (await request('/api/me/security-phrase', { headers })).json()).toEqual({ phrase: null });

    expect(
      (await request('/api/me/security-phrase', { method: 'PUT', headers, body: JSON.stringify({ phrase: 'ab' }) })).status,
    ).toBe(400);
    await request('/api/me/security-phrase', { method: 'PUT', headers, body: JSON.stringify({ phrase: ' gato azul 🐱 ' }) });
    expect(await (await request('/api/me/security-phrase', { headers })).json()).toEqual({ phrase: 'gato azul 🐱' });
    const [row] = await db.select().from(users).where(eq(users.telegramId, userId));
    expect(row?.securityPhrase).not.toContain('gato');

    const placed = await place();
    expect(placed.status).toBe(201);
    const { orderId } = (await placed.json()) as { orderId: string };
    await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await db.delete(orders).where(eq(orders.id, orderId));
    await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
  });

  it('lets the organiser take products out of a paid order: the difference is owed back', async () => {
    const admin = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`, 'content-type': 'application/json' };
    const auth = { Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`, 'content-type': 'application/json' };
    await db.delete(carts).where(eq(carts.userId, CUSTOMER_ID));
    await request('/api/cart/items', { method: 'POST', headers: auth, body: JSON.stringify({ productId, quantity: 2 }) });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@alice_test' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    await request(`/api/admin/orders/${orderId}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'paid' }) });
    const [before] = await db.select().from(orders).where(eq(orders.id, orderId));
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const [productBefore] = await db.select().from(products).where(eq(products.id, productId));
    const reduce = (quantity: number, reason = 'Sold out') =>
      request(`/api/admin/orders/${orderId}/reduce`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ lines: [{ productId, variantId: null, quantity }], reason }),
      });

    const preview = await request(`/api/admin/orders/${orderId}/reduce-preview`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ lines: [{ productId, variantId: null, quantity: 1 }] }),
    });
    expect(await preview.json()).toEqual({
      total: before!.total - item!.unitPrice,
      amountDue: -item!.unitPrice,
      testingBack: 0,
    });
    expect((await reduce(3)).status).toBe(400); // never up
    expect((await reduce(0)).status).toBe(400); // nothing left: cancel instead
    const res = await reduce(1);
    expect(res.status).toBe(200);
    const order = (await res.json()) as { total: number; amountDue: number; status: string; items: Array<{ quantity: number }> };
    expect(order.status).toBe('paid');
    expect(order.items[0]?.quantity).toBe(1);
    expect(order.total).toBe(before!.total - item!.unitPrice);
    expect(order.amountDue).toBe(-item!.unitPrice);
    const [productAfter] = await db.select().from(products).where(eq(products.id, productId));
    if (productBefore?.stock !== null && productBefore?.stock !== undefined) {
      expect(productAfter?.stock).toBe(productBefore.stock + 1);
    }

    await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await db.delete(orders).where(eq(orders.id, orderId));
    await db.update(products).set({ stock: 10 }).where(eq(products.id, productId));
  });

  it('lets administrators set the GB currency', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const set = async (currency: string): Promise<Response> =>
      request('/api/admin/shop/currency', {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ currency }),
      });
    const eur = await set('EURC');
    expect(eur.status).toBe(200);
    expect(((await eur.json()) as { currency: string }).currency).toBe('EURC');
    expect((await set('BTC')).status).toBe(400);
    expect((await set('USDC')).status).toBe(200);
  });

  it('asks only for what the GB says: the Telegram @ can be optional', async () => {
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const fields = (contact: 'optional' | 'required', email: 'off' | 'optional') =>
      request('/api/admin/shop/checkout-fields', {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ contact, name: 'off', email, phone: 'off', notes: 'off' }),
      });
    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const order = (body: object): Promise<Response> =>
      Promise.resolve(request('/api/orders', { method: 'POST', headers: auth, body: JSON.stringify(body) }));

    // Required by default.
    const without = await order({});
    expect(without.status).toBe(400);
    expect(((await without.json()) as { error: { code: string } }).error.code).toBe('contact_required');

    // Encrypted details need the GB's key, also without shipping.
    const saved = await fields('optional', 'optional');
    expect(((await saved.json()) as { checkoutFields: { email: string } }).checkoutFields.email).toBe('optional');
    const noKey = await order({ encryptedAddress: '{"v":1}' });
    expect(noKey.status).toBe(409);

    // Optional: the order goes through without it.
    const placed = await order({});
    expect(placed.status).toBe(201);
    const { orderId } = (await placed.json()) as { orderId: string };
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row?.contactUsername).toBeNull();

    await fields('required', 'off');
    await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await db.delete(orders).where(eq(orders.id, orderId));
  });

  it('lets the customer add details to an order not sent yet, never replacing them', async () => {
    const auth = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const placed = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await placed.json()) as { orderId: string };
    const envelope = (kid: string): string => JSON.stringify({ v: 1, kid, key: 'k', iv: 'i', data: 'd' });
    const [before] = await db.select().from(shops).where(eq(shops.id, shopId));
    await db.update(shops).set({ addressKeyFingerprint: 'kid-now' }).where(eq(shops.id, shopId));
    const add = (encrypted: string): Promise<Response> =>
      Promise.resolve(
        request(`/api/orders/${orderId}/details`, { method: 'POST', headers: auth, body: JSON.stringify({ encrypted }) }),
      );

    // Nothing to add to without delivery details.
    expect((await add(envelope('kid-now'))).status).toBe(400);

    await db
      .update(orders)
      .set({ encryptedAddress: envelope('kid-now'), addressKeyFingerprint: 'kid-now' })
      .where(eq(orders.id, orderId));
    // Encrypted with an old key: refused.
    expect((await add(envelope('kid-old'))).status).toBe(409);
    const ok = await add(envelope('kid-now'));
    expect(ok.status).toBe(200);
    const added = (await ok.json()) as { encryptedAddress: string; addressExtras: Array<{ encrypted: string }> };
    expect(added.addressExtras).toHaveLength(1);
    // What the order had stays as it was.
    expect(added.encryptedAddress).toBe(envelope('kid-now'));

    // Once sent, only through the organiser.
    await db.update(orders).set({ status: 'shipped' }).where(eq(orders.id, orderId));
    expect((await add(envelope('kid-now'))).status).toBe(409);

    await db.update(shops).set({ addressKeyFingerprint: before?.addressKeyFingerprint ?? null }).where(eq(shops.id, shopId));
    await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await db.delete(orders).where(eq(orders.id, orderId));
  });

  it('counts a little overpayment, within the GB margin, as the exact price', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Admin')}`,
      'content-type': 'application/json',
    };
    const customer = {
      Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`,
      'content-type': 'application/json',
    };
    const margin = await request('/api/admin/shop/overpay-margin', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ amount: 10 }),
    });
    expect(margin.status).toBe(200);
    const newOrder = async (): Promise<{ id: string; total: number }> => {
      await request('/api/cart/items', {
        method: 'POST',
        headers: customer,
        body: JSON.stringify({ productId, quantity: 1 }),
      });
      const created = await request('/api/orders', {
        method: 'POST',
        headers: customer,
        body: JSON.stringify({ contactUsername: '@test_user' }),
      });
      const { orderId } = (await created.json()) as { orderId: string };
      const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
      return { id: orderId, total: row?.total ?? 0 };
    };

    // 0.05 too much: paid, nothing to refund.
    const small = await newOrder();
    const paid = await markOrderPaid(db, small.id, 'tx-small', { received: small.total + 5 });
    expect(paid.status).toBe('paid');
    expect(paid.amountPaid).toBe(small.total);
    expect(paid.amountDue).toBe(0);

    // 0.50 too much: beyond the margin, the refund is noted as before.
    const big = await newOrder();
    const over = await markOrderPaid(db, big.id, 'tx-big', { received: big.total + 50 });
    expect(over.amountPaid).toBe(big.total + 50);
    expect(over.amountDue).toBe(-50);

    await request('/api/admin/shop/overpay-margin', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ amount: 0 }),
    });
  });

  it('cancels unpaid orders after the shop deadline', async () => {
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };

    const fresh = await cancelExpiredOrders(db, { BOT_TOKEN } as Env);
    const [stillPending] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(stillPending?.status).toBe('pending');
    expect(fresh).toBe(0);

    await db
      .update(orders)
      .set({ updatedAt: new Date(Date.now() - 49 * 60 * 60 * 1000) })
      .where(eq(orders.id, orderId));
    expect(await cancelExpiredOrders(db, { BOT_TOKEN } as Env)).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row?.status).toBe('cancelled');
    expect(row?.closedAt).not.toBeNull();
  });

  it('deletes a shop with its orders only after confirming its name', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const adminAuth = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    await authToken(CUSTOMER_ID, 'Alice');

    const [shop] = await db
      .insert(shops)
      .values({ slug: `to-delete-${Date.now()}`, name: 'Test Shop', description: '', currency: 'USDC' })
      .returning();
    const [product] = await db
      .insert(products)
      .values({
        shopId: shop!.id,
        slug: 'thing',
        title: 'Thing',
        description: '',
        price: 100,
        currency: 'USDC',
        stock: null,
        isActive: true,
      })
      .returning();
    const [order] = await db
      .insert(orders)
      .values({ shopId: shop!.id, userId: CUSTOMER_ID, total: 100, currency: 'USDC' })
      .returning();
    await db.insert(orderItems).values({
      orderId: order!.id,
      productId: product!.id,
      title: 'Thing',
      unitPrice: 100,
      quantity: 1,
      subtotal: 100,
    });

    const contents = await request(`/api/platform/shops/${shop!.id}/contents`, {
      headers: adminAuth,
    });
    expect(await contents.json()).toEqual({ orders: 1, products: 1, categories: 0, carts: 0 });

    const wrong = await request(`/api/platform/shops/${shop!.id}/delete-all`, {
      method: 'POST',
      headers: adminAuth,
      body: JSON.stringify({ confirmName: 'Test' }),
    });
    expect(wrong.status).toBe(400);

    const ok = await request(`/api/platform/shops/${shop!.id}/delete-all`, {
      method: 'POST',
      headers: adminAuth,
      body: JSON.stringify({ confirmName: 'Test Shop' }),
    });
    expect(ok.status).toBe(200);
    expect(await db.select().from(shops).where(eq(shops.id, shop!.id))).toHaveLength(0);
    expect(await db.select().from(orders).where(eq(orders.id, order!.id))).toHaveLength(0);
  });

  it('saves the language chosen in the app', async () => {
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const res = await request('/api/me/language', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'es' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ language: 'es', preferredLanguage: 'es' });

    const again = await request('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: signInitData(CUSTOMER_ID, 'Alice') }),
    });
    expect(((await again.json()) as { user: { language: string } }).user.language).toBe('es');

    // Spanish errors once the app asks for them.
    const missing = await request('/api/orders/00000000-0000-4000-8000-000000000000', {
      headers: { Authorization: `Bearer ${token}`, 'X-Lang': 'es' },
    });
    expect(((await missing.json()) as { error: { message: string } }).error.message).toBe(
      'Pedido no encontrado',
    );
  });

  it('shows VIP-only shops only to members of their VIP club', async () => {
    const BOB_ID = 555000222;
    const alice = await authToken(CUSTOMER_ID, 'Alice');
    const bob = await authToken(BOB_ID, 'Bob');
    const admin = await authToken(ADMIN_ID, 'Ivan');
    await db.update(users).set({ username: 'Bob_Vip' }).where(eq(users.telegramId, BOB_ID));

    const [shop] = await db
      .insert(shops)
      .values({
        slug: `vip-${Date.now()}`,
        name: 'VIP Shop',
        description: '',
        currency: 'USDC',
        vipOnly: true,
        useGlobalVipClub: false,
        vipClub: { groups: [], userIds: [], usernames: ['bob_vip'] },
      })
      .returning();
    const shopRef = shop!.id;

    const listed = async (token: string): Promise<Array<{ id: string; isVip: boolean }>> => {
      const res = await request('/api/shops', { headers: { Authorization: `Bearer ${token}` } });
      return ((await res.json()) as { shops: Array<{ id: string; isVip: boolean }> }).shops;
    };
    const open = (token: string): Promise<Response> =>
      Promise.resolve(
        request('/api/shop', { headers: { Authorization: `Bearer ${token}`, 'X-Shop': shopRef } }),
      );

    // Not in the club: the shop does not exist for Alice.
    expect((await listed(alice)).some((s) => s.id === shopRef)).toBe(false);
    expect((await open(alice)).status).toBe(404);

    // Listed by @username: Bob sees it, and the username becomes his id.
    expect((await listed(bob)).find((s) => s.id === shopRef)?.isVip).toBe(true);
    const bobOpens = await open(bob);
    expect(bobOpens.status).toBe(200);
    expect(((await bobOpens.json()) as { isVip: boolean }).isVip).toBe(true);
    const [row] = await db.select().from(shops).where(eq(shops.id, shopRef));
    expect(row?.vipClub).toEqual({ groups: [], userIds: [BOB_ID], usernames: [] });

    // Admins always see it.
    expect((await listed(admin)).some((s) => s.id === shopRef)).toBe(true);

    // The platform club counts once the shop accepts it.
    const adminAuth = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const saved = await request('/api/platform/vip-club', {
      method: 'PUT',
      headers: adminAuth,
      body: JSON.stringify({ groups: [], userIds: [CUSTOMER_ID], usernames: [] }),
    });
    expect(saved.status).toBe(200);
    expect((await listed(alice)).some((s) => s.id === shopRef)).toBe(false);
    await db.update(shops).set({ useGlobalVipClub: true }).where(eq(shops.id, shopRef));
    expect((await listed(alice)).some((s) => s.id === shopRef)).toBe(true);

    // Shop admins edit the shop's own club.
    const own = await request('/api/admin/shop/vip-club', {
      method: 'PUT',
      headers: { ...adminAuth, 'X-Shop': shopRef },
      body: JSON.stringify({ groups: [], userIds: [], usernames: ['carol_x'], useGlobalClub: false }),
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({
      groups: [],
      userIds: [],
      usernames: ['carol_x'],
      useGlobalClub: false,
    });
    expect((await listed(bob)).some((s) => s.id === shopRef)).toBe(false);

    await request('/api/platform/vip-club', {
      method: 'PUT',
      headers: adminAuth,
      body: JSON.stringify({ groups: [], userIds: [], usernames: [] }),
    });
    await db.delete(shops).where(eq(shops.id, shopRef));
  });

  it('lets guests into "VIP and guests" shops without making them VIPs', async () => {
    const DAN_ID = 555000333;
    const alice = await authToken(CUSTOMER_ID, 'Alice');
    const dan = await authToken(DAN_ID, 'Dan');
    const admin = await authToken(ADMIN_ID, 'Ivan');
    await db.update(users).set({ username: 'Dan_Guest' }).where(eq(users.telegramId, DAN_ID));

    const [shop] = await db
      .insert(shops)
      .values({
        slug: `guests-${Date.now()}`,
        name: 'Guest Shop',
        description: '',
        currency: 'USDC',
        vipOnly: true,
        allowGuests: true,
        useGlobalVipClub: false,
        useGlobalGuests: false,
        guestList: { groups: [], userIds: [], usernames: ['dan_guest'] },
      })
      .returning();
    const shopRef = shop!.id;
    const listed = async (token: string): Promise<Array<{ id: string; isVip: boolean }>> => {
      const res = await request('/api/shops', { headers: { Authorization: `Bearer ${token}` } });
      return ((await res.json()) as { shops: Array<{ id: string; isVip: boolean }> }).shops;
    };
    const open = (token: string): Promise<Response> =>
      Promise.resolve(
        request('/api/shop', { headers: { Authorization: `Bearer ${token}`, 'X-Shop': shopRef } }),
      );

    // A guest sees it, but is not a VIP; the @username becomes the id.
    expect((await listed(dan)).find((s) => s.id === shopRef)?.isVip).toBe(false);
    const danOpens = await open(dan);
    expect(danOpens.status).toBe(200);
    expect(((await danOpens.json()) as { isVip: boolean }).isVip).toBe(false);
    const [row] = await db.select().from(shops).where(eq(shops.id, shopRef));
    expect(row?.guestList).toEqual({ groups: [], userIds: [DAN_ID], usernames: [] });
    expect((await open(alice)).status).toBe(404);

    // "Only VIP" again: guests no longer get in.
    await db.update(shops).set({ allowGuests: false }).where(eq(shops.id, shopRef));
    expect((await listed(dan)).some((s) => s.id === shopRef)).toBe(false);
    expect((await open(dan)).status).toBe(404);
    await db.update(shops).set({ allowGuests: true }).where(eq(shops.id, shopRef));

    // The general guests count once the shop accepts them.
    const adminAuth = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const general = await request('/api/platform/guests', {
      method: 'PUT',
      headers: adminAuth,
      body: JSON.stringify({ groups: [], userIds: [CUSTOMER_ID], usernames: [] }),
    });
    expect(general.status).toBe(200);
    expect((await listed(alice)).some((s) => s.id === shopRef)).toBe(false);
    const own = await request('/api/admin/shop/guests', {
      method: 'PUT',
      headers: { ...adminAuth, 'X-Shop': shopRef },
      body: JSON.stringify({ groups: [], userIds: [], usernames: [], useGlobalClub: true }),
    });
    expect(await own.json()).toEqual({ groups: [], userIds: [], usernames: [], useGlobalClub: true });
    expect((await listed(alice)).some((s) => s.id === shopRef)).toBe(true);
    expect((await listed(dan)).some((s) => s.id === shopRef)).toBe(false);

    await request('/api/platform/guests', {
      method: 'PUT',
      headers: adminAuth,
      body: JSON.stringify({ groups: [], userIds: [], usernames: [] }),
    });
    await db.delete(shops).where(eq(shops.id, shopRef));
  });

  it('shows "how it works" once per account, and not to customers', async () => {
    const newcomer = await authToken(555000444, 'Nina');
    const auth = { Authorization: `Bearer ${newcomer}` };
    const showHowTo = async (token: string): Promise<boolean | undefined> => {
      const res = await request('/api/shops', { headers: { Authorization: `Bearer ${token}` } });
      return ((await res.json()) as { showHowTo?: boolean }).showHowTo;
    };
    expect(await showHowTo(newcomer)).toBe(true);
    const seen = await request('/api/me/how-to-seen', { method: 'POST', headers: auth });
    expect(seen.status).toBe(200);
    expect(await showHowTo(newcomer)).toBe(false);
    // The team never gets it.
    expect(await showHowTo(await authToken(ADMIN_ID, 'Ivan'))).toBe(false);
  });

  it('copies products with variants and categories from another shop', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const auth = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const stamp = Date.now();
    const [from] = await db
      .insert(shops)
      .values({ slug: `from-${stamp}`, name: 'From', description: '', currency: 'USDC' })
      .returning();
    const [into] = await db
      .insert(shops)
      .values({ slug: `into-${stamp}`, name: 'Into', description: '', currency: 'USDC' })
      .returning();
    const [cat] = await db
      .insert(categories)
      .values({ shopId: from!.id, slug: 'shirts', title: 'Shirts', sortOrder: 3 })
      .returning();
    const [shirt] = await db
      .insert(products)
      .values({
        shopId: from!.id,
        categoryId: cat!.id,
        slug: 'shirt',
        title: 'Shirt',
        description: 'Cotton',
        price: 1000,
        currency: 'USDC',
        stock: null,
        isActive: true,
        options: [{ name: 'Size', values: ['S', 'M'] }],
        priceTiers: [{ minQty: 5, price: 900 }],
      })
      .returning();
    await db.insert(productVariants).values([
      { productId: shirt!.id, optionValues: ['S'], price: null, stock: 4, sortOrder: 0 },
      { productId: shirt!.id, optionValues: ['M'], price: 1100, stock: 2, sortOrder: 1 },
    ]);
    // The target already has a product with the same link name.
    await db.insert(products).values({
      shopId: into!.id,
      slug: 'shirt',
      title: 'Old shirt',
      description: '',
      price: 500,
      currency: 'USDC',
      stock: null,
      isActive: true,
    });

    const sources = await request('/api/admin/clone-sources', {
      headers: { ...auth, 'X-Shop': into!.id },
    });
    const list = (await sources.json()) as Array<{ id: string; products: Array<{ variantCount: number }> }>;
    expect(list.find((s) => s.id === from!.id)?.products[0]?.variantCount).toBe(2);

    const res = await request('/api/admin/clone', {
      method: 'POST',
      headers: { ...auth, 'X-Shop': into!.id },
      body: JSON.stringify({ sourceShopId: from!.id, productIds: [shirt!.id], copyStock: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ products: 1, categories: 1 });

    const [copy] = await db
      .select()
      .from(products)
      .where(and(eq(products.shopId, into!.id), eq(products.slug, 'shirt-2')));
    expect(copy).toMatchObject({ title: 'Shirt', price: 1000, isActive: false, stock: null });
    expect(copy?.priceTiers).toEqual([{ minQty: 5, price: 900 }]);
    const copiedVariants = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, copy!.id));
    expect(copiedVariants.map((v) => [v.optionValues, v.price, v.stock])).toEqual([
      [['S'], null, null],
      [['M'], 1100, null],
    ]);
    const [newCat] = await db.select().from(categories).where(eq(categories.id, copy!.categoryId!));
    expect(newCat).toMatchObject({ shopId: into!.id, slug: 'shirts', title: 'Shirts' });

    // Customers cannot copy.
    const alice = await authToken(CUSTOMER_ID, 'Alice');
    const denied = await request('/api/admin/clone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice}`, 'content-type': 'application/json', 'X-Shop': into!.id },
      body: JSON.stringify({ sourceShopId: from!.id, productIds: [shirt!.id], copyStock: false }),
    });
    expect(denied.status).toBe(403);

    await db.delete(shops).where(inArray(shops.id, [from!.id, into!.id]));
  });

  it('reminds customers once about orders still to pay, with a link to the order', async () => {
    await authToken(CUSTOMER_ID, 'Alice');
    const [shop] = await db
      .insert(shops)
      .values({ slug: `remind-${Date.now()}`, name: 'Remind', description: '', currency: 'USDC', autoCancelHours: 48 })
      .returning();
    const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000);
    const [due] = await db
      .insert(orders)
      .values({ shopId: shop!.id, userId: CUSTOMER_ID, total: 500, currency: 'USDC', updatedAt: hoursAgo(30) })
      .returning();
    const [fresh] = await db
      .insert(orders)
      .values({ shopId: shop!.id, userId: CUSTOMER_ID, total: 700, currency: 'USDC', updatedAt: hoursAgo(2) })
      .returning();

    // The shop list shows the unpaid orders.
    const alice = await authToken(CUSTOMER_ID, 'Alice');
    const list = await request('/api/shops', { headers: { Authorization: `Bearer ${alice}` } });
    const listed = ((await list.json()) as { shops: Array<{ id: string; unpaidOrders: number }> }).shops;
    expect(listed.find((s) => s.id === shop!.id)?.unpaidOrders).toBe(2);

    const telegram = new TelegramApi(BOT_TOKEN);
    resetMiniAppUrlCache();
    vi.spyOn(telegram, 'getChatMenuButton').mockResolvedValue({
      type: 'web_app',
      web_app: { url: 'https://shop.example.app/' },
    });
    const send = vi.spyOn(telegram, 'sendMessage').mockResolvedValue(true);
    await sendPaymentReminders(db, testEnv, telegram);
    const mine = send.mock.calls.filter(([, text]) => text.includes(due!.id.slice(0, 8)));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.[1]).toContain('5.00 USDC');
    expect(mine[0]?.[1]).toContain('18 h');
    expect(mine[0]?.[2]?.inline_keyboard[0]?.[0]?.web_app?.url).toBe(
      `https://shop.example.app/?shop=${shop!.slug}&order=${due!.id}`,
    );
    expect(send.mock.calls.some(([, text]) => text.includes(fresh!.id.slice(0, 8)))).toBe(false);

    // Only once.
    send.mockClear();
    await sendPaymentReminders(db, testEnv, telegram);
    expect(send.mock.calls.some(([, text]) => text.includes(due!.id.slice(0, 8)))).toBe(false);
    resetMiniAppUrlCache();
    await db.delete(shops).where(eq(shops.id, shop!.id));
  });

  it('closes a GB: no new orders, unpaid ones and carts go, paid ones stay', async () => {
    const BOB_ID = 555000222;
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const alice = await authToken(CUSTOMER_ID, 'Alice');
    const bob = await authToken(BOB_ID, 'Bob');
    const [shop] = await db
      .insert(shops)
      .values({ slug: `closing-${Date.now()}`, name: 'Closing', description: '', currency: 'USDC' })
      .returning();
    const ref = shop!.id;
    const [product] = await db
      .insert(products)
      .values({ shopId: ref, slug: 'thing', title: 'Thing', description: '', price: 100, currency: 'USDC', stock: null, isActive: true })
      .returning();
    const [unpaid] = await db
      .insert(orders)
      .values({ shopId: ref, userId: CUSTOMER_ID, total: 100, currency: 'USDC' })
      .returning();
    const [paid] = await db
      .insert(orders)
      .values({ shopId: ref, userId: BOB_ID, total: 100, amountPaid: 100, status: 'paid', currency: 'USDC' })
      .returning();
    const [cart] = await db.insert(carts).values({ shopId: ref, userId: BOB_ID }).returning();
    await db.insert(cartItems).values({ cartId: cart!.id, productId: product!.id, quantity: 1 });

    const as = (token: string) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json', 'X-Shop': ref });
    const listed = async (token: string) =>
      ((await (await request('/api/shops', { headers: as(token) })).json()) as {
        shops: Array<{ id: string; isClosed: boolean }>;
      }).shops.find((s) => s.id === ref);

    const preview = await request('/api/admin/shop/close-preview', { headers: as(admin) });
    expect(await preview.json()).toMatchObject({ unpaidOrders: 1, carts: 1, paymentsToReview: 0 });

    const close = await request('/api/admin/shop/close', { method: 'POST', headers: as(admin) });
    expect(((await close.json()) as { isClosed: boolean }).isClosed).toBe(true);
    expect(await db.select().from(orders).where(eq(orders.id, unpaid!.id))).toHaveLength(0);
    expect(await db.select().from(orders).where(eq(orders.id, paid!.id))).toHaveLength(1);
    expect(await db.select().from(carts).where(eq(carts.shopId, ref))).toHaveLength(0);

    // Alice has no orders left there: it is gone for her. Bob can still look.
    expect(await listed(alice)).toBeUndefined();
    expect((await listed(bob))?.isClosed).toBe(true);
    expect((await request(`/api/orders/${paid!.id}`, { headers: as(bob) })).status).toBe(200);
    const add = await request('/api/cart/items', {
      method: 'POST',
      headers: as(bob),
      body: JSON.stringify({ productId: product!.id, quantity: 1 }),
    });
    expect(add.status).toBe(409);

    // Reopen, then a scheduled closing: closed from that moment, finalized by maintenance.
    await request('/api/admin/shop/reopen', { method: 'POST', headers: as(admin) });
    const past = await request('/api/admin/shop/closing', {
      method: 'PUT',
      headers: as(admin),
      body: JSON.stringify({ closesAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    expect(past.status).toBe(400);
    const future = await request('/api/admin/shop/closing', {
      method: 'PUT',
      headers: as(admin),
      body: JSON.stringify({ closesAt: new Date(Date.now() + 3_600_000).toISOString(), warnHours: 6 }),
    });
    expect(await future.json()).toMatchObject({ isClosed: false, closingWarnHours: 6 });
    await db.update(shops).set({ closesAt: new Date(Date.now() - 1000) }).where(eq(shops.id, ref));
    const late = await request('/api/cart/items', {
      method: 'POST',
      headers: as(bob),
      body: JSON.stringify({ productId: product!.id, quantity: 1 }),
    });
    expect(late.status).toBe(409);
    expect(await closeDueShops(db, testEnv)).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(shops).where(eq(shops.id, ref));
    expect(row?.closedAt).not.toBeNull();
    expect(row?.closesAt).toBeNull();

    await db.delete(shops).where(eq(shops.id, ref));
  });

  it('lets organisers create and run their own GBs, and nobody else\'s', async () => {
    const send = vi.spyOn(TelegramApi.prototype, 'sendMessage').mockResolvedValue(true);
    const ORG_ID = 555000222;
    const LATER_ID = 555000333;
    const json = (token: string, shop?: string): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(shop ? { 'X-Shop': shop } : {}),
    });
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const org = await authToken(ORG_ID, 'Olga', 'olga_gb');
    const slugName = `olga-${Date.now()}`;
    const newShop = JSON.stringify({ name: 'Olga GB', slug: slugName, description: '', imageUrl: null });

    // Not an organiser yet.
    const denied = await request('/api/organizer/shops', { method: 'POST', headers: json(org), body: newShop });
    expect(denied.status).toBe(403);

    // The super-admin names organisers by @username: known ones become ids, the rest wait.
    const set = await request('/api/platform/organizers', {
      method: 'PUT',
      headers: json(admin),
      body: JSON.stringify({ people: ['@Olga_GB', 'future_org'] }),
    });
    expect(set.status).toBe(200);
    const organizers = (await set.json()) as {
      organizers: { telegramId: number }[];
      pendingUsernames: string[];
    };
    expect(organizers.organizers.map((p) => p.telegramId)).toEqual([ORG_ID]);
    expect(organizers.pendingUsernames).toEqual(['future_org']);

    // A new GB: hidden, with its creator as administrator. Super-admins hear of it.
    const created = await request('/api/organizer/shops', { method: 'POST', headers: json(org), body: newShop });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ isVisible: false, ownerIds: [ORG_ID], adminIds: [] });
    expect(send).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('@olga_gb'));

    // The administrator adds a manager by @username who has never opened the app: pending.
    const owner = await request('/api/admin/shop/owner', {
      method: 'PUT',
      headers: json(org, slugName),
      body: JSON.stringify({ isVisible: true, vipOnly: false, owners: [String(ORG_ID)], admins: ['@later_admin'] }),
    });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({
      isVisible: true,
      ownerIds: [ORG_ID],
      adminIds: [],
      adminUsernames: ['later_admin'],
    });
    // Never without an administrator.
    const noOwner = await request('/api/admin/shop/owner', {
      method: 'PUT',
      headers: json(org, slugName),
      body: JSON.stringify({ isVisible: true, vipOnly: false, owners: ['@nobody_yet'], admins: [] }),
    });
    expect(noOwner.status).toBe(400);

    // On their first visit they become a manager: no team, payments or key.
    const later = await authToken(LATER_ID, 'Leo', 'Later_Admin');
    const asAdmin = await request('/api/admin/shop', { headers: json(later, slugName) });
    expect(asAdmin.status).toBe(200);
    expect(await asAdmin.json()).toMatchObject({ ownerIds: [ORG_ID], adminIds: [LATER_ID], adminUsernames: [] });
    expect((await request('/api/admin/shop/team', { headers: json(later, slugName) })).status).toBe(403);
    const wallets = await request('/api/admin/shop/payments', {
      method: 'PUT',
      headers: json(later, slugName),
      body: JSON.stringify({ evmAddress: null, solanaAddress: null, accepted: [] }),
    });
    expect(wallets.status).toBe(403);

    // A second administrator: now they can.
    const promoted = await request('/api/admin/shop/owner', {
      method: 'PUT',
      headers: json(org, slugName),
      body: JSON.stringify({ isVisible: true, vipOnly: false, owners: [String(ORG_ID), '@Later_Admin'], admins: [] }),
    });
    expect(await promoted.json()).toMatchObject({ ownerIds: [ORG_ID, LATER_ID], adminIds: [] });
    expect((await request('/api/admin/shop/team', { headers: json(later, slugName) })).status).toBe(200);

    // "Organised by" lists the admins.
    const config = await request('/api/shop', { headers: json(later, slugName) });
    expect(((await config.json()) as { organizers: unknown }).organizers).toEqual([
      { username: 'olga_gb', name: 'Olga' },
      { username: 'Later_Admin', name: 'Leo' },
    ]);

    // Hidden by the administrators: customers no longer receive the names; the team still does.
    const hidden = await request('/api/admin/shop/owner', {
      method: 'PUT',
      headers: json(org, slugName),
      body: JSON.stringify({
        isVisible: true,
        vipOnly: false,
        showOrganizers: false,
        owners: [String(ORG_ID), '@Later_Admin'],
        admins: [],
      }),
    });
    expect(await hidden.json()).toMatchObject({ showOrganizers: false });
    const customer = await authToken(CUSTOMER_ID, 'Alice');
    const seen = await request('/api/shop', { headers: json(customer, slugName) });
    expect(((await seen.json()) as { organizers: unknown[] }).organizers).toEqual([]);
    const forTeam = await request('/api/shop', { headers: json(later, slugName) });
    expect(((await forTeam.json()) as { organizers: unknown[] }).organizers).toHaveLength(2);

    // Nothing of anyone else's: other GBs, the platform.
    expect([403, 404]).toContain((await request('/api/admin/shop', { headers: json(org) })).status);
    expect((await request('/api/platform/shops', { headers: json(org) })).status).toBe(403);

    // The owner deletes the GB; super-admins hear of it.
    const deleted = await request('/api/admin/shop/delete-all', {
      method: 'POST',
      headers: json(org, slugName),
      body: JSON.stringify({ confirmName: 'Olga GB' }),
    });
    expect(deleted.status).toBe(200);
    expect(send).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('Olga GB'));

    await request('/api/platform/organizers', {
      method: 'PUT',
      headers: json(admin),
      body: JSON.stringify({ people: [] }),
    });
    send.mockRestore();
  });

  it('tells every admin when the address key changes', async () => {
    const send = vi.spyOn(TelegramApi.prototype, 'sendMessage').mockResolvedValue(true);
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const headers = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const set = await request('/api/admin/shop/address-key', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ publicKey: pem }),
    });
    expect(set.status).toBe(200);
    const fingerprint = ((await set.json()) as { addressKeyFingerprint: string }).addressKeyFingerprint;
    expect(send).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining(fingerprint));

    // Saving the same key again says nothing.
    send.mockClear();
    await request('/api/admin/shop/address-key', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ publicKey: pem }),
    });
    expect(send).not.toHaveBeenCalled();

    await request('/api/admin/shop/address-key', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ publicKey: null }),
    });
    send.mockRestore();
  });

  it('takes payments with a manual method (Wise…) for an admin to check', async () => {
    const send = vi.spyOn(TelegramApi.prototype, 'sendMessage').mockResolvedValue(true);
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const adminAuth = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const view = (await (await request('/api/admin/shop', { headers: adminAuth })).json()) as {
      paymentSetup: Record<string, unknown>;
    };
    const original = view.paymentSetup;
    const wise = { id: 'wise', name: 'Wise', instructions: 'Send it to @pepepe', isActive: true };
    const saved = await request('/api/admin/shop/payments', {
      method: 'PUT',
      headers: adminAuth,
      body: JSON.stringify({ ...original, manual: [wise] }),
    });
    expect(saved.status).toBe(200);
    // Like a wallet address, new instructions are announced to the admins.
    expect(send).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('Send it to @pepepe'));

    const config = (await (await request('/api/shop', { headers: auth })).json()) as {
      manualMethods: unknown;
    };
    expect(config.manualMethods).toEqual([
      { id: 'wise', name: 'Wise', instructions: 'Send it to @pepepe' },
    ]);

    await request('/api/cart/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    const create = await request('/api/orders', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };

    send.mockClear();
    const paid = await request(`/api/orders/${orderId}/manual-payment`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ methodId: 'wise', reference: 'Alice W.' }),
    });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({
      status: 'awaiting_payment',
      paymentManual: true,
      paymentNetwork: 'Wise',
      paymentTxHash: 'Alice W.',
      paymentCheck: null,
    });
    expect(send).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('Alice W.'));

    // Nothing to check on-chain; the admin confirms by hand.
    const recheck = await request(`/api/admin/orders/${orderId}/recheck`, {
      method: 'POST',
      headers: adminAuth,
    });
    expect(recheck.status).toBe(409);
    const confirm = await request(`/api/admin/orders/${orderId}`, {
      method: 'PATCH',
      headers: adminAuth,
      body: JSON.stringify({ status: 'paid' }),
    });
    expect(confirm.status).toBe(200);
    expect(((await confirm.json()) as { status: string }).status).toBe('paid');

    await request('/api/admin/shop/payments', {
      method: 'PUT',
      headers: adminAuth,
      body: JSON.stringify({ ...original, manual: [] }),
    });
    send.mockRestore();
  });

  it('gives VIPs their price (no tiers) and, if the GB says so, no fee', async () => {
    const OTHER_ID = 555000444;
    const vipToken = await authToken(CUSTOMER_ID, 'Alice');
    const otherToken = await authToken(OTHER_ID, 'Bob');
    const vip = { Authorization: `Bearer ${vipToken}`, 'content-type': 'application/json' };
    const other = { Authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' };

    await db
      .update(shops)
      .set({ vipClub: { groups: [], userIds: [CUSTOMER_ID], usernames: [] }, orderFee: 50, vipNoFee: true, vipOrderFee: 0 })
      .where(eq(shops.id, shopId));
    await db
      .update(products)
      .set({ vipPrice: 99, priceTiers: [{ minQty: 2, price: 80 }] })
      .where(eq(products.id, productId));

    // Only VIPs see the VIP price.
    const seen = async (headers: Record<string, string>): Promise<number | null> =>
      ((await (await request(`/api/products/${productId}`, { headers })).json()) as { vipPrice: number | null })
        .vipPrice;
    expect(await seen(vip)).toBe(99);
    expect(await seen(other)).toBeNull();

    const cartOf = async (headers: Record<string, string>) => {
      const res = await request('/api/cart/items', {
        method: 'POST',
        headers,
        body: JSON.stringify({ productId, quantity: 2 }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        isVip: boolean;
        fee: number;
        lines: Array<{ unitPrice: number }>;
      };
    };
    // A VIP always pays the VIP price, even where a tier would be cheaper.
    const vipCart = await cartOf(vip);
    expect(vipCart).toMatchObject({ isVip: true, fee: 0 });
    expect(vipCart.lines[0]?.unitPrice).toBe(99);
    const otherCart = await cartOf(other);
    expect(otherCart).toMatchObject({ isVip: false, fee: 50 });
    // A reduced fee for VIPs, set by the organiser: they pay it, the rest the normal one.
    const adminHeaders = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Ivan')}`, 'content-type': 'application/json' };
    const reduced = await request('/api/admin/shop/fee', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ orderFee: 50, orderFeeLabel: 'Fee', vipOrderFee: 20 }),
    });
    expect(await reduced.json()).toMatchObject({ vipOrderFee: 20, vipNoFee: false });
    expect((await (await request('/api/cart', { headers: vip })).json()) as { fee: number }).toMatchObject({ fee: 20 });
    expect((await (await request('/api/cart', { headers: other })).json()) as { fee: number }).toMatchObject({ fee: 50 });
    // The older on/off still works: no fee for VIPs.
    await request('/api/admin/shop/fee', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ orderFee: 50, orderFeeLabel: 'Fee', vipNoFee: true }),
    });
    expect(otherCart.lines[0]?.unitPrice).toBe(80);

    const create = await request('/api/orders', {
      method: 'POST',
      headers: vip,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    expect(create.status).toBe(201);
    const { orderId } = (await create.json()) as { orderId: string };
    const order = (await (await request(`/api/orders/${orderId}`, { headers: vip })).json()) as {
      isVip: boolean;
      fee: number;
      total: number;
      items: Array<{ unitPrice: number }>;
    };
    expect(order).toMatchObject({ isVip: true, fee: 0, total: 198 });
    expect(order.items[0]?.unitPrice).toBe(99);

    await request(`/api/orders/${orderId}`, { method: 'DELETE', headers: vip });
    await db
      .update(shops)
      .set({ vipClub: { groups: [], userIds: [], usernames: [] }, orderFee: 0, vipNoFee: false, vipOrderFee: null })
      .where(eq(shops.id, shopId));
    await db.update(products).set({ vipPrice: null, priceTiers: [] }).where(eq(products.id, productId));
  });

  it('shows VIP-only products only to VIPs', async () => {
    const vip = { Authorization: `Bearer ${await authToken(CUSTOMER_ID, 'Alice')}`, 'content-type': 'application/json' };
    const other = {
      Authorization: `Bearer ${await authToken(555000444, 'Bob')}`,
      'content-type': 'application/json',
    };
    await db
      .update(shops)
      .set({ vipClub: { groups: [], userIds: [CUSTOMER_ID], usernames: [] } })
      .where(eq(shops.id, shopId));
    await db.update(products).set({ vipOnly: true }).where(eq(products.id, productId));

    const listed = async (headers: Record<string, string>): Promise<boolean> =>
      ((await (await request('/api/products?limit=150', { headers })).json()) as { items: Array<{ id: string }> }).items.some(
        (p) => p.id === productId,
      );
    expect(await listed(vip)).toBe(true);
    expect(await listed(other)).toBe(false);
    expect((await request(`/api/products/${productId}`, { headers: other })).status).toBe(404);
    const add = await request('/api/cart/items', {
      method: 'POST',
      headers: other,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    expect(add.status).toBe(403);
    expect(((await add.json()) as { error: { code: string } }).error.code).toBe('vip_only');
    // Already in a non-VIP's cart: it is left out.
    const cart = (await (await request('/api/cart', { headers: other })).json()) as {
      lines: Array<{ product: { id: string } }>;
    };
    expect(cart.lines.some((l) => l.product.id === productId)).toBe(false);

    await db.update(products).set({ vipOnly: false }).where(eq(products.id, productId));
    await db
      .update(shops)
      .set({ vipClub: { groups: [], userIds: [], usernames: [] } })
      .where(eq(shops.id, shopId));
  });

  it('duplicates a GB: settings and catalog, hidden, without orders', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const headers = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    await db.update(shops).set({ orderFee: 25, vipNoFee: true, vipOrderFee: 0 }).where(eq(shops.id, shopId));
    await db.update(products).set({ vipPrice: 120 }).where(eq(products.id, productId));

    const res = await request('/api/admin/shop/duplicate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Second round', slug: `second-round-${Date.now()}` }),
    });
    expect(res.status).toBe(201);
    const copy = (await res.json()) as { id: string };
    expect(copy).toMatchObject({
      name: 'Second round',
      isVisible: false,
      isClosed: false,
      ownerIds: [ADMIN_ID],
      adminIds: [],
      orderFee: 25,
      vipNoFee: true,
      vipOrderFee: 0,
    });

    // Donation products (made with testings) are not copied.
    const source = await db
      .select()
      .from(products)
      .where(and(eq(products.shopId, shopId), eq(products.kind, 'sale')));
    const copied = await db.select().from(products).where(eq(products.shopId, copy.id));
    expect(copied.map((p) => p.slug).sort()).toEqual(source.map((p) => p.slug).sort());
    expect(copied.find((p) => p.slug === 'sencha')?.vipPrice).toBe(120);
    expect(await db.select().from(orders).where(eq(orders.shopId, copy.id))).toHaveLength(0);

    await db.delete(shops).where(eq(shops.id, copy.id));
    await db.update(shops).set({ orderFee: 0, vipNoFee: false, vipOrderFee: null }).where(eq(shops.id, shopId));
    await db.update(products).set({ vipPrice: null }).where(eq(products.id, productId));
  });

  it('a copy of a GB takes its labs and its testings as set up, open and with nobody in them', async () => {
    const admin = {
      Authorization: `Bearer ${await authToken(ADMIN_ID, 'Ivan')}`,
      'content-type': 'application/json',
    };
    await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) });
    const lab = await request('/api/admin/labs', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name: 'Lab Copia', currency: 'USDC', tests: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 1 }] }),
    });
    expect(lab.status).toBe(201);
    const labId = ((await lab.json()) as { id: string }).id;
    const created = await request('/api/admin/testings', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        productId,
        variantId: null,
        lab: 'Lab Copia',
        contribution: 300,
        perUnit: 50,
        feeMode: 'optional',
        allowExternal: true,
        tiers: [{ id: 'mp', name: 'M&P', cost: 5000, vials: 1 }],
      }),
    });
    expect(created.status).toBe(201);
    const original = (await created.json()) as { id: string };
    let copyId: string | null = null;
    try {
      const res = await request('/api/admin/shop/duplicate', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ name: 'Con testing', slug: `con-testing-${Date.now()}` }),
      });
      expect(res.status).toBe(201);
      copyId = ((await res.json()) as { id: string }).id;
      const [shop] = await db.select().from(shops).where(eq(shops.id, copyId));
      expect(shop?.testingEnabled).toBe(true);
      const copiedLabs = await db.select().from(labs).where(eq(labs.shopId, copyId));
      expect(copiedLabs.map((l) => l.name)).toContain('Lab Copia');
      const [sencha] = await db
        .select()
        .from(products)
        .where(and(eq(products.shopId, copyId), eq(products.slug, 'sencha')));
      const copied = await db.select().from(testings).where(eq(testings.productId, sencha!.id));
      expect(copied).toHaveLength(1);
      expect(copied[0]).toMatchObject({
        status: 'open',
        lab: 'Lab Copia',
        contribution: 300,
        perUnit: 50,
        feeMode: 'optional',
        allowExternal: true,
        report: null,
        draw: null,
      });
      expect(copied[0]!.donationProductId).not.toBeNull();
      expect(await db.select().from(testingEntries).where(eq(testingEntries.testingId, copied[0]!.id))).toHaveLength(0);
    } finally {
      if (copyId) await db.delete(shops).where(eq(shops.id, copyId));
      await request(`/api/admin/testings/${original.id}`, { method: 'DELETE', headers: admin });
      await db.delete(labs).where(eq(labs.id, labId));
      await request('/api/admin/shop/testing', { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) });
    }
  });

  it('imports products from CSV after a preview, and exports them through the bot', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const headers = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const csv = [
      'producto;titulo;categoria;precio;opcion1;valor1;stock_variante',
      'csv-shirt;CSV shirt;From CSV;12,50;Size;M;4',
      'csv-shirt;;;;;L;',
      'sencha;Sencha;;1,60;;;',
    ].join('\n');

    const preview = await request('/api/admin/products/csv/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ csv }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      errors: [],
      newCategories: ['From CSV'],
      products: [
        { slug: 'csv-shirt', action: 'create', variants: 2 },
        { slug: 'sencha', action: 'update', variants: 0 },
      ],
    });

    const bad = await request('/api/admin/products/csv/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ csv: 'producto;titulo;precio\nBAD;x;1' }),
    });
    expect(bad.status).toBe(400);

    const done = await request('/api/admin/products/csv/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ csv }),
    });
    expect(await done.json()).toEqual({ created: 1, updated: 1, categoriesCreated: 1 });
    const [sencha] = await db.select().from(products).where(eq(products.id, productId));
    expect(sencha?.price).toBe(160);

    const send = vi.spyOn(TelegramApi.prototype, 'sendDocument').mockResolvedValue(true);
    const exported = await request('/api/admin/products/csv/export', { method: 'POST', headers });
    expect(exported.status).toBe(200);
    const text = (send.mock.calls[0]?.[2] as Buffer).toString('utf8');
    expect(text).toContain('csv-shirt');
    send.mockRestore();

    await db.delete(products).where(and(eq(products.shopId, shopId), eq(products.slug, 'csv-shirt')));
    await db.update(products).set({ price: 150 }).where(eq(products.id, productId));
  });

  it('backs a GB up as JSON and imports it as a new GB after confirming its wallets', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const headers = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const send = vi.spyOn(TelegramApi.prototype, 'sendDocument').mockResolvedValue(true);
    const exported = await request('/api/admin/shop/backup', { method: 'POST', headers });
    expect(exported.status).toBe(200);
    const backup = JSON.parse((send.mock.calls[0]?.[2] as Buffer).toString('utf8')) as {
      format: string;
      shop: { paymentSetup: { evmAddress: string | null; solanaAddress: string | null } | null };
      products: unknown[];
    };
    send.mockRestore();
    expect(backup.format).toBe('tma-gb');

    const preview = await request('/api/organizer/shops/import/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ backup }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ slugTaken: true, products: backup.products.length });

    const slugName = `restored-${Date.now()}`;
    const evm = backup.shop.paymentSetup?.evmAddress ?? null;
    const solana = backup.shop.paymentSetup?.solanaAddress ?? null;
    const unconfirmed = await request('/api/organizer/shops/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        backup,
        name: 'Restored',
        slug: slugName,
        confirmedEvmAddress: '0x0000000000000000000000000000000000000001',
        confirmedSolanaAddress: solana,
      }),
    });
    expect(unconfirmed.status).toBe(400);

    const imported = await request('/api/organizer/shops/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        backup,
        name: 'Restored',
        slug: slugName,
        confirmedEvmAddress: evm,
        confirmedSolanaAddress: solana,
      }),
    });
    expect(imported.status).toBe(201);
    const copy = (await imported.json()) as { id: string; isVisible: boolean; ownerIds: number[] };
    expect(copy).toMatchObject({ isVisible: false, ownerIds: [ADMIN_ID] });
    const copied = await db.select().from(products).where(eq(products.shopId, copy.id));
    expect(copied).toHaveLength(backup.products.length);

    // Customers cannot import.
    const customer = await authToken(CUSTOMER_ID, 'Alice');
    const denied = await request('/api/organizer/shops/import/preview', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ backup }),
    });
    expect(denied.status).toBe(403);
    await db.delete(shops).where(eq(shops.id, copy.id));
  });

  it('owners keep running their GBs unless the super-admin also takes the GBs away', async () => {
    const ORG_ID = 555000555;
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const org = await authToken(ORG_ID, 'Olga');
    const adminHeaders = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const [gb] = await db
      .insert(shops)
      .values({ slug: `owned-${Date.now()}`, name: 'Owned', ownerIds: [ORG_ID], currency: 'USDC' })
      .returning();
    const team = async (): Promise<number> =>
      (await request('/api/admin/shop/team', {
        headers: { Authorization: `Bearer ${org}`, 'X-Shop': gb!.slug },
      })).status;
    const setOrganizers = (people: string[], releaseShops?: boolean): Promise<Response> =>
      Promise.resolve(
        request('/api/platform/organizers', {
          method: 'PUT',
          headers: adminHeaders,
          body: JSON.stringify({ people, releaseShops }),
        }),
      );

    // Owning a GB is enough, organiser or not.
    expect(await team()).toBe(200);
    const listed = await setOrganizers([String(ORG_ID)]);
    expect(((await listed.json()) as { organizers: Array<{ ownedShops: number }> }).organizers[0]?.ownedShops).toBe(1);
    await setOrganizers([]);
    expect(await team()).toBe(200);

    // Taking the role away together with the GBs.
    await setOrganizers([String(ORG_ID)]);
    await setOrganizers([], true);
    const [after] = await db.select().from(shops).where(eq(shops.id, gb!.id));
    expect(after?.ownerIds).toEqual([]);
    expect(await team()).not.toBe(200);
    await db.delete(shops).where(eq(shops.id, gb!.id));
  });

  it('takes a CSV sent to the bot and opens it in the app for import', async () => {
    const UPLOADER = 555000666;
    resetMiniAppUrlCache();
    const menu = vi
      .spyOn(TelegramApi.prototype, 'getChatMenuButton')
      .mockResolvedValue({ type: 'web_app', web_app: { url: 'https://app.example' } });
    const download = vi
      .spyOn(TelegramApi.prototype, 'downloadFile')
      .mockResolvedValue(Buffer.from('producto;titulo;precio\nx;X;1', 'utf8'));
    const send = vi.spyOn(TelegramApi.prototype, 'sendMessage').mockResolvedValue(true);
    const token = await authToken(UPLOADER, 'Uma');
    await db.update(shops).set({ adminIds: [UPLOADER] }).where(eq(shops.id, shopId));

    const res = await app.request('/webhook/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'whsec-test' },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: UPLOADER, type: 'private' },
          from: { id: UPLOADER, first_name: 'Uma' },
          document: { file_id: 'f1', file_name: 'products.csv', file_size: 40 },
        },
      }),
    });
    expect(res.status).toBe(200);
    const keyboard = send.mock.calls[0]?.[2] as { inline_keyboard: Array<Array<{ web_app?: { url: string } }>> };
    const url = keyboard.inline_keyboard[0]?.[0]?.web_app?.url ?? '';
    expect(url).toMatch(/^https:\/\/app\.example\?upload=[0-9a-f-]{36}$/);
    const uploadId = url.split('upload=')[1] ?? '';

    const opened = await request(`/api/uploads/${uploadId}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await opened.json()).toMatchObject({ kind: 'csv', fileName: 'products.csv' });
    const other = await authToken(CUSTOMER_ID, 'Alice');
    expect((await request(`/api/uploads/${uploadId}`, { headers: { Authorization: `Bearer ${other}` } })).status).toBe(404);
    expect(
      (await request(`/api/uploads/${uploadId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(204);

    await db.update(shops).set({ adminIds: [] }).where(eq(shops.id, shopId));
    menu.mockRestore();
    download.mockRestore();
    send.mockRestore();
    resetMiniAppUrlCache();
  });

  it('sends a message to the GB buyers through the bot and keeps a record', async () => {
    resetMiniAppUrlCache();
    const menu = vi
      .spyOn(TelegramApi.prototype, 'getChatMenuButton')
      .mockResolvedValue({ type: 'web_app', web_app: { url: 'https://app.example' } });
    const send = vi.spyOn(TelegramApi.prototype, 'sendMessage').mockResolvedValue(true);
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const headers = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const token = await authToken(CUSTOMER_ID, 'Alice');
    await request('/api/cart/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ productId, quantity: 1 }),
    });

    const count = await request('/api/admin/broadcasts/count?audience=cart', { headers });
    expect(((await count.json()) as { count: number }).count).toBeGreaterThanOrEqual(1);

    const res = await request('/api/admin/broadcasts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ audience: 'cart', text: 'The parcel arrives on Friday' }),
    });
    expect(res.status).toBe(201);
    await vi.waitFor(
      async () => {
        const list = (await (await request('/api/admin/broadcasts', { headers })).json()) as Array<{
          status: string;
          sent: number;
        }>;
        expect(list[0]?.status).toBe('done');
      },
      { timeout: 5000, interval: 100 },
    );
    expect(send).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.stringContaining('The parcel arrives on Friday'),
      expect.anything(),
    );
    // The sender hears how it went.
    expect(send).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('reached'));

    const forbidden = await request('/api/admin/broadcasts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ audience: 'orders', text: 'spam' }),
    });
    expect(forbidden.status).toBe(403);
    send.mockRestore();
    menu.mockRestore();
    resetMiniAppUrlCache();
  });

  it('lists the buyers one per person, with everything each has, and writes to one', async () => {
    const menu = vi
      .spyOn(TelegramApi.prototype, 'getChatMenuButton')
      .mockResolvedValue({ type: 'web_app', web_app: { url: 'https://app.example' } });
    const send = vi.spyOn(TelegramApi.prototype, 'sendMessage').mockResolvedValue(true);
    const headers = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Ivan')}`, 'content-type': 'application/json' };
    const token = await authToken(CUSTOMER_ID, 'Alice');
    await request('/api/cart/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ productId, quantity: 2 }),
    });
    try {
      const list = (await (await request('/api/admin/buyers', { headers })).json()) as Array<{
        telegramId: number;
        cartUnits: number;
      }>;
      const alice = list.find((b) => b.telegramId === CUSTOMER_ID);
      expect(alice?.cartUnits).toBeGreaterThanOrEqual(2);
      // VIP is whether they are one now, not whether an order was placed as one.
      const [before] = await db.select().from(shops).where(eq(shops.id, shopId));
      await db
        .update(shops)
        .set({ vipClub: { groups: [], usernames: [], userIds: [CUSTOMER_ID] } })
        .where(eq(shops.id, shopId));
      const vipList = (await (await request('/api/admin/buyers', { headers })).json()) as Array<{
        telegramId: number;
        vip: boolean;
      }>;
      expect(vipList.find((b) => b.telegramId === CUSTOMER_ID)?.vip).toBe(true);
      await db.update(shops).set({ vipClub: before!.vipClub }).where(eq(shops.id, shopId));
      const detail = (await (await request(`/api/admin/buyers/${CUSTOMER_ID}`, { headers })).json()) as {
        cart: Array<{ quantity: number }>;
        orderList: unknown[];
      };
      expect(detail.cart.length).toBeGreaterThan(0);
      expect((await request('/api/admin/buyers/555000999', { headers })).status).toBe(404);
      const res = await request(`/api/admin/buyers/${CUSTOMER_ID}/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'Your parcel is ready' }),
      });
      expect(await res.json()).toEqual({ sent: true });
      expect(send).toHaveBeenCalledWith(CUSTOMER_ID, expect.stringContaining('Your parcel is ready'), expect.anything());
      // Not for customers.
      expect((await request('/api/admin/buyers', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    } finally {
      send.mockRestore();
      menu.mockRestore();
      resetMiniAppUrlCache();
    }
  });

  it('says who a message did not reach, and checks who cannot get messages without sending any', async () => {
    const menu = vi
      .spyOn(TelegramApi.prototype, 'getChatMenuButton')
      .mockResolvedValue({ type: 'web_app', web_app: { url: 'https://app.example' } });
    // The customer never pressed Start: Telegram refuses.
    const refuse = (chatId: number): Promise<unknown> =>
      chatId === CUSTOMER_ID ? Promise.reject(new Error('Forbidden: bot can\'t initiate conversation')) : Promise.resolve(true);
    const send = vi.spyOn(TelegramApi.prototype, 'sendMessage').mockImplementation(refuse);
    const typing = vi.spyOn(TelegramApi.prototype, 'sendChatAction').mockImplementation(refuse);
    const headers = { Authorization: `Bearer ${await authToken(ADMIN_ID, 'Ivan')}`, 'content-type': 'application/json' };
    const token = await authToken(CUSTOMER_ID, 'Alice');
    await request('/api/cart/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    try {
      await request('/api/admin/broadcasts', {
        method: 'POST',
        headers,
        body: JSON.stringify({ audience: 'cart', text: 'Unreached?' }),
      });
      await vi.waitFor(
        async () => {
          const list = (await (await request('/api/admin/broadcasts', { headers })).json()) as Array<{
            status: string;
            unreached: Array<{ telegramId: number }>;
          }>;
          expect(list[0]?.status).toBe('done');
          expect(list[0]?.unreached.map((p) => p.telegramId)).toContain(CUSTOMER_ID);
        },
        { timeout: 5000, interval: 100 },
      );
      // Nothing is sent to check: only "typing…", and the result to whoever asked.
      send.mockClear();
      const res = await request('/api/admin/broadcasts/reach', {
        method: 'POST',
        headers,
        body: JSON.stringify({ audience: 'cart' }),
      });
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(ADMIN_ID, expect.stringContaining('cannot get messages')), {
        timeout: 5000,
        interval: 100,
      });
      expect(typing).toHaveBeenCalledWith(CUSTOMER_ID);
      // The app follows it too (for those on the web, who get no bot message).
      const { id } = (await res.json()) as { id: string };
      const status = (await (await request(`/api/admin/broadcasts/reach/${id}`, { headers })).json()) as {
        done: boolean;
        unreached: Array<{ telegramId: number }>;
      };
      expect(status.done).toBe(true);
      expect(status.unreached.map((p) => p.telegramId)).toContain(CUSTOMER_ID);
      expect(send).not.toHaveBeenCalledWith(CUSTOMER_ID, expect.anything(), expect.anything());
    } finally {
      send.mockRestore();
      typing.mockRestore();
      menu.mockRestore();
      resetMiniAppUrlCache();
    }
  });

  it('asks customers to accept the GB disclaimer before anything else', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const adminHeaders = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const setText = (text: string, askAgain: boolean): Promise<Response> =>
      Promise.resolve(
        request('/api/admin/shop/disclaimer', {
          method: 'PUT',
          headers: adminHeaders,
          body: JSON.stringify({ text, askAgain }),
        }),
      );
    const config = async () =>
      (await (await request('/api/shop', { headers })).json()) as {
        disclaimer: { version: number } | null;
        disclaimerAccepted: boolean;
      };

    expect((await setText('Private group buy, no refunds.', false)).status).toBe(200);
    expect(await config()).toMatchObject({ disclaimer: { version: 1 }, disclaimerAccepted: false });
    expect((await request('/api/products', { headers })).status).toBe(403);
    // Admins never have to accept it.
    expect((await request('/api/products', { headers: adminHeaders })).status).toBe(200);

    const accept = (version: number): Promise<Response> =>
      Promise.resolve(
        request('/api/shop/disclaimer/accept', {
          method: 'POST',
          headers,
          body: JSON.stringify({ version }),
        }),
      );
    expect((await accept(1)).status).toBe(204);
    expect((await request('/api/products', { headers })).status).toBe(200);

    // A minor correction keeps it accepted; asking again does not.
    await setText('Private group buy. No refunds.', false);
    expect((await config()).disclaimerAccepted).toBe(true);
    await setText('Private group buy. No refunds. Shipping in 4 weeks.', true);
    expect(await config()).toMatchObject({ disclaimer: { version: 2 }, disclaimerAccepted: false });
    expect((await accept(1)).status).toBe(409);
    expect((await accept(2)).status).toBe(204);
    const view = (await (await request('/api/admin/shop/disclaimer', { headers: adminHeaders })).json()) as {
      accepted: number;
    };
    expect(view.accepted).toBe(1);

    await setText('', false);
    expect((await config()).disclaimer).toBeNull();
  });

  it('sends the shipping list to the admin chat and deletes it a day later', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const headers = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const send = vi
      .spyOn(TelegramApi.prototype, 'sendDocument')
      .mockResolvedValue({ message_id: 4242 });
    const remove = vi.spyOn(TelegramApi.prototype, 'deleteMessage').mockResolvedValue(true);

    const res = await request('/api/admin/shipping-list/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fileName: 'test-shipping.csv', csv: 'a,b\n1,2', count: 1 }),
    });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith(ADMIN_ID, 'test-shipping.csv', expect.any(Buffer), 'text/csv', expect.any(String));

    // Not yet; then, a day later, the bot deletes it.
    expect(await deleteExpiredMessages(db, testEnv)).toBe(0);
    expect(await deleteExpiredMessages(db, testEnv, undefined, new Date(Date.now() + 25 * 3600_000))).toBe(1);
    expect(remove).toHaveBeenCalledWith(ADMIN_ID, 4242);
    send.mockRestore();
    remove.mockRestore();
  });

  it('moves GBs up and down the list, and puts new ones last', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const headers = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const stamp = Date.now();
    const make = async (name: string): Promise<string> => {
      const res = await request('/api/platform/shops', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name,
          slug: `${name.toLowerCase()}-${stamp}`,
          description: '',
          imageUrl: null,
          isVisible: true,
          vipOnly: false,
          sortOrder: 0,
          admins: [],
          owners: [],
        }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const a = await make('Alpha');
    const b = await make('Beta');
    const order = async (): Promise<string[]> =>
      ((await (await request('/api/platform/shops', { headers })).json()) as Array<{ id: string }>)
        .map((s) => s.id)
        .filter((id) => id === a || id === b);
    expect(await order()).toEqual([a, b]);

    const moved = await request(`/api/platform/shops/${b}/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ direction: 'up' }),
    });
    expect(moved.status).toBe(200);
    expect(await order()).toEqual([b, a]);

    await db.delete(shops).where(inArray(shops.id, [a, b]));
  });

  it('keeps an English title for products and GBs, searchable and frozen in orders', async () => {
    const admin = await authToken(ADMIN_ID, 'Ivan');
    const adminHeaders = { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const token = await authToken(CUSTOMER_ID, 'Alice');
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await db
      .update(products)
      .set({ titleEn: 'Green tea', descriptionEn: 'Loose leaf' })
      .where(eq(products.id, productId));

    const found = (await (await request('/api/products?search=green', { headers })).json()) as {
      items: Array<{ id: string; title: string; titleEn: string | null }>;
    };
    expect(found.items.map((p) => p.id)).toContain(productId);
    expect(found.items.find((p) => p.id === productId)).toMatchObject({ title: 'Sencha', titleEn: 'Green tea' });

    await request('/api/cart/items', { method: 'POST', headers, body: JSON.stringify({ productId, quantity: 1 }) });
    const create = await request('/api/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ contactUsername: '@test_user' }),
    });
    const { orderId } = (await create.json()) as { orderId: string };
    const order = (await (await request(`/api/orders/${orderId}`, { headers })).json()) as {
      items: Array<{ title: string; titleEn: string | null }>;
    };
    expect(order.items[0]).toMatchObject({ title: 'Sencha', titleEn: 'Green tea' });
    await request(`/api/orders/${orderId}`, { method: 'DELETE', headers });

    // The GB too; an empty English text means "none".
    const profile = await request('/api/admin/shop/profile', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Test Shop', description: '', nameEn: 'Test GB', descriptionEn: '  ', imageUrl: null }),
    });
    expect(await profile.json()).toMatchObject({ nameEn: 'Test GB', descriptionEn: null });
    const listed = (await (await request('/api/shops', { headers })).json()) as {
      shops: Array<{ id: string; nameEn: string | null }>;
    };
    expect(listed.shops.find((s) => s.id === shopId)?.nameEn).toBe('Test GB');

    await db.update(products).set({ titleEn: null, descriptionEn: null }).where(eq(products.id, productId));
    await db.update(shops).set({ nameEn: null }).where(eq(shops.id, shopId));
  });

  it('enforces admin-only routes', async () => {
    const customer = await authToken(CUSTOMER_ID, 'Alice');
    const denied = await request('/api/admin/orders', {
      headers: { Authorization: `Bearer ${customer}` },
    });
    expect(denied.status).toBe(403);

    const admin = await authToken(ADMIN_ID, 'Ivan');
    const allowed = await request('/api/admin/orders', {
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(allowed.status).toBe(200);
  });
});
