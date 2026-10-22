import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { AppBindings, AppDeps } from './context.js';
import { ApiError, errorResponse } from './lib/errors.js';
import { withShop } from './middleware/shop.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requireDisclaimer } from './auth/middleware.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { cartRoutes } from './routes/cart.js';
import { orderRoutes } from './routes/orders.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhook.js';
import { shopsRoutes } from './routes/shops.js';
import { platformRoutes } from './routes/platform.js';
import { meRoutes } from './routes/me.js';
import { organizerRoutes } from './routes/organizer.js';
import { uploadRoutes } from './routes/uploads.js';
import { webAccountRoutes } from './routes/webAccounts.js';

export function createApp(deps: AppDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // Inject shared dependencies into every request.
  app.use('*', async (c, next) => {
    c.set('env', deps.env);
    c.set('db', deps.db);
    await next();
  });

  const origin = deps.env.CORS_ORIGIN;
  app.use(
    '*',
    cors({
      origin: origin === '*' ? '*' : origin.split(',').map((o) => o.trim()),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Shop', 'X-Lang'],
    }),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) return errorResponse(c, err);
    console.error('Unhandled error:', err);
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Nothing legitimate is bigger than this (the largest is a 2 MB CSV); a
  // huge body would only fill the memory of a small server.
  const tooBig = (): never => {
    throw new ApiError(413, 'too_large', 'The request is too large');
  };
  app.use('/api/*', bodyLimit({ maxSize: 3 * 1024 * 1024, onError: tooBig }));
  app.use('/webhook/*', bodyLimit({ maxSize: 1024 * 1024, onError: tooBig }));
  // Requests per minute per client (the webhook is not limited: Telegram
  // proves itself with its secret, and a limit could lose bot messages).
  app.use('/api/*', rateLimit);

  // Telegram webhook is not shop-scoped (it reconciles by order id).
  app.route('/webhook', webhookRoutes());

  const api = new Hono<AppBindings>();

  // Not tied to a shop.
  api.route('/auth', authRoutes());
  api.route('/shops', shopsRoutes());
  api.route('/platform', platformRoutes());
  api.route('/me', meRoutes());
  api.route('/organizer', organizerRoutes());
  api.route('/uploads', uploadRoutes());
  api.route('/web-accounts', webAccountRoutes());

  // Shop routes: the `X-Shop` header (id or slug) picks the shop.
  for (const path of ['/shop', '/categories', '/products', '/cart', '/orders', '/admin']) {
    api.use(path, withShop);
    api.use(`${path}/*`, withShop);
  }
  // Nothing of the GB until its disclaimer is accepted (GET /shop shows it).
  for (const path of ['/categories', '/products', '/cart', '/orders']) {
    api.use(path, requireDisclaimer);
    api.use(`${path}/*`, requireDisclaimer);
  }
  api.route('/', catalogRoutes());
  api.route('/cart', cartRoutes());
  api.route('/orders', orderRoutes());
  api.route('/admin', adminRoutes());

  app.route('/api', api);

  return app;
}
