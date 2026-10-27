import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { createApp } from '../app.js';
import { base32Decode, createWebAdmin, removeWebAdmin, resetWebAdmin, totpCode } from '../services/webAdmins.js';
import { addWebNotice } from '../services/webNotices.js';
import type { Env } from '../config/env.js';
import { createDb, createPool, type Database } from '../db/client.js';
import { and, eq, inArray } from 'drizzle-orm';
import {
  cartItems,
  carts,
  categories,
  orderItems,
  orders,
  productVariants,
  products,
  shops,
  users,
} from '../db/schema.js';
import { runRetention } from '../services/retention.js';
import { cancelExpiredOrders } from '../services/autoCancel.js';
import { markOrderPaid } from '../services/orders.js';
import { sendPaymentReminders } from '../services/reminders.js';
import { resetMiniAppUrlCache } from '../services/bot.js';
import { closeDueShops } from '../services/closing.js';
import { deleteExpiredMessages } from '../services/expiringMessages.js';
import { TelegramApi } from '../telegram/api.js';

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

  async function authToken(userId: number, name: string, username?: string): Promise<string> {
    const res = await request('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: signInitData(userId, name, username) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
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

    // The platform blacklist hides every GB.
    await app.request('/api/platform/blacklist', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID), removeData: false }),
    });
    expect(await sees()).toBe(false);
    await app.request('/api/platform/blacklist/remove', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ who: String(CUSTOMER_ID) }),
    });
    expect(await sees()).toBe(true);
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
      .set({ vipClub: { groups: [], userIds: [CUSTOMER_ID], usernames: [] }, orderFee: 50, vipNoFee: true })
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
      .set({ vipClub: { groups: [], userIds: [], usernames: [] }, orderFee: 0, vipNoFee: false })
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
    await db.update(shops).set({ orderFee: 25, vipNoFee: true }).where(eq(shops.id, shopId));
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
    });

    const source = await db.select().from(products).where(eq(products.shopId, shopId));
    const copied = await db.select().from(products).where(eq(products.shopId, copy.id));
    expect(copied.map((p) => p.slug).sort()).toEqual(source.map((p) => p.slug).sort());
    expect(copied.find((p) => p.slug === 'sencha')?.vipPrice).toBe(120);
    expect(await db.select().from(orders).where(eq(orders.shopId, copy.id))).toHaveLength(0);

    await db.delete(shops).where(eq(shops.id, copy.id));
    await db.update(shops).set({ orderFee: 0, vipNoFee: false }).where(eq(shops.id, shopId));
    await db.update(products).set({ vipPrice: null }).where(eq(products.id, productId));
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
