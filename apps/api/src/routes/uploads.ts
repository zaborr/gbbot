import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings } from '../context.js';
import { requireAuth } from '../auth/middleware.js';
import { deleteUpload, getUpload } from '../services/uploads.js';

const idParam = z.object({ id: z.uuid() });

/** Files the user sent to the bot, for the Mini App's import screens. */
export function uploadRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use('*', requireAuth);

  app.get('/:id', zValidator('param', idParam), async (c) =>
    c.json(await getUpload(c.get('db'), c.get('claims').sub, c.req.valid('param').id)),
  );

  // Done with it (imported): no need to keep it until it expires.
  app.delete('/:id', zValidator('param', idParam), async (c) => {
    await deleteUpload(c.get('db'), c.get('claims').sub, c.req.valid('param').id);
    return c.body(null, 204);
  });

  return app;
}
