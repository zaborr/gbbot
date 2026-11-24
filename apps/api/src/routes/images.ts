import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings } from '../context.js';
import { getImage } from '../services/images.js';

/** Images uploaded from the app, for anyone (a GB's picture is public). */
export function imageRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.get('/:id', zValidator('param', z.object({ id: z.uuid() })), async (c) =>
    getImage(c.get('db'), c.req.valid('param').id),
  );
  return app;
}
