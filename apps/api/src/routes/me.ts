import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { updateLanguageRequest } from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { requireAuth } from '../auth/middleware.js';
import { setPreferredLanguage } from '../services/users.js';
import { toSessionUserDTO } from '../db/mappers.js';

/** The signed-in user's own settings. */
export function meRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth);

  // Language chosen in the app (null = follow Telegram); also used by the bot.
  app.put('/language', zValidator('json', updateLanguageRequest), async (c) => {
    const { sub, role } = c.get('claims');
    const row = await setPreferredLanguage(c.get('db'), sub, c.req.valid('json').language);
    return c.json(toSessionUserDTO(row, role));
  });

  return app;
}
