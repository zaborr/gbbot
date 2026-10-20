import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { AppBindings } from '../context.js';
import type { TelegramUpdate } from '../telegram/types.js';
import { handleBotMessage } from '../services/bot.js';
import { ApiError } from '../lib/errors.js';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Telegram webhook endpoint. Telegram authenticates itself with the secret token
 * configured via `setWebhook`, sent in the `X-Telegram-Bot-Api-Secret-Token`
 * header. We always answer 200 quickly so Telegram does not retry on app errors.
 */
export function webhookRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/telegram', async (c) => {
    const env = c.get('env');
    // No secret configured: the webhook is off (nobody can fake a payment).
    if (!env.TELEGRAM_WEBHOOK_SECRET) throw ApiError.notFound('Webhook disabled');
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
    if (!safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
      throw ApiError.unauthorized('Invalid webhook secret');
    }

    const update = (await c.req.json()) as TelegramUpdate;
    try {
      await handleBotMessage(env, update, undefined, c.get('db'));
    } catch (error) {
      // Log and still acknowledge: a 5xx makes Telegram retry the same update.
      console.error('Webhook handling error:', error);
    }
    return c.json({ ok: true });
  });

  return app;
}
