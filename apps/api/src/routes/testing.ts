import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createTestingRequest, updateTestingRequest } from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { createTesting, deleteTesting, listTestings, updateTesting } from '../services/testing.js';

const idParam = z.object({ id: z.uuid() });

/** `/api/admin/testings`: the GB's product testings (any manager, like products). */
export function testingAdminRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/', async (c) => c.json(await listTestings(c.get('db'), c.get('shopId'))));
  app.post('/', zValidator('json', createTestingRequest), async (c) =>
    c.json(await createTesting(c.get('db'), c.get('shop'), c.req.valid('json')), 201),
  );
  app.put('/:id', zValidator('param', idParam), zValidator('json', updateTestingRequest), async (c) =>
    c.json(
      await updateTesting(c.get('db'), c.get('shopId'), c.req.valid('param').id, c.req.valid('json')),
    ),
  );
  app.delete('/:id', zValidator('param', idParam), async (c) => {
    await deleteTesting(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.json({ ok: true });
  });

  return app;
}
