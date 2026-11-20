import { announceNewTesting, moveTestingWindow, reopenTesting } from '../services/testingDonations.js';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createTestingRequest, labProgressRequest, langFrom, MAX_DONATION_HOURS, updateTestingRequest } from '@tma-shop/shared';
import type { AppBindings } from '../context.js';
import { drawBlocker, launchDraw, substituteDonor } from '../services/testingDraw.js';
import { cancelTesting, markLabProgress, requestReport, settleTesting } from '../services/testingSettle.js';
import { languagesOf } from '../services/notifications.js';
import { ApiError } from '../lib/errors.js';
import {
  createTesting,
  deleteTesting,
  listParticipants,
  listTestings,
  updateTesting,
} from '../services/testing.js';

const idParam = z.object({ id: z.uuid() });

/** `/api/admin/testings`: the GB's product testings (any manager, like products). */
export function testingAdminRoutes(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/', async (c) => c.json(await listTestings(c.get('db'), c.get('shopId'))));
  app.post('/', zValidator('json', createTestingRequest), async (c) => {
    const created = await createTesting(c.get('db'), c.get('shop'), c.req.valid('json'));
    // Those who already bought it hear about it (in the background).
    void announceNewTesting(c.get('db'), c.get('env'), c.get('shop'), created.id).catch((error: unknown) =>
      console.error('Testing announcement failed:', error),
    );
    return c.json(created, 201);
  });
  app.put('/:id', zValidator('param', idParam), zValidator('json', updateTestingRequest), async (c) =>
    c.json(
      await updateTesting(c.get('db'), c.get('shopId'), c.req.valid('param').id, c.req.valid('json')),
    ),
  );
  // The draw of donors: whether it can be launched, launching it, and replacing a donor.
  app.get('/:id/draw', zValidator('param', idParam), async (c) => {
    const testing = await c
      .get('db')
      .query.testings.findFirst({ where: (t, { and, eq }) => and(eq(t.shopId, c.get('shopId')), eq(t.id, c.req.valid('param').id)) });
    if (!testing) throw ApiError.notFound('Testing not found');
    return c.json({ blocker: await drawBlocker(c.get('db'), c.get('shop'), testing) });
  });
  app.post('/:id/draw', zValidator('param', idParam), async (c) => {
    await launchDraw(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id);
    return c.json({ ok: true });
  });
  app.post(
    '/:id/substitute',
    zValidator('param', idParam),
    zValidator('json', z.object({ ref: z.string().min(1).max(16) })),
    async (c) => {
      await substituteDonor(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id, c.req.valid('json').ref);
      return c.json({ ok: true });
    },
  );
  // Settling the money, cancelling, and asking (through the bot) for the lab report.
  // Closing it: donors get their vial's price back on their order.
  // After the draw: vials sent to the lab, received there, or the day results are expected.
  app.post('/:id/lab', zValidator('param', idParam), zValidator('json', labProgressRequest), async (c) => {
    await markLabProgress(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id, c.req.valid('json'));
    return c.json({ ok: true });
  });

  app.post('/:id/settle', zValidator('param', idParam), async (c) => {
    await settleTesting(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id);
    return c.json({ ok: true });
  });
  // The time to join and give opens again (closed, or settled with nothing reached).
  app.post(
    '/:id/reopen',
    zValidator('param', idParam),
    zValidator('json', z.object({ hours: z.number().int().min(1).max(MAX_DONATION_HOURS) })),
    async (c) => {
      await reopenTesting(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id, c.req.valid('json').hours);
      return c.json({ ok: true });
    },
  );
  // The open time to join and give ends some hours from now (longer or shorter), or now (0).
  app.post(
    '/:id/window',
    zValidator('param', idParam),
    zValidator('json', z.object({ hours: z.number().int().min(0).max(MAX_DONATION_HOURS) })),
    async (c) => {
      await moveTestingWindow(c.get('db'), c.get('shop'), c.req.valid('param').id, c.req.valid('json').hours);
      return c.json({ ok: true });
    },
  );
  app.post('/:id/cancel', zValidator('param', idParam), async (c) => {
    await cancelTesting(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id);
    return c.json({ ok: true });
  });
  app.post('/:id/report-request', zValidator('param', idParam), async (c) => {
    const sub = c.get('claims').sub;
    const lang = (await languagesOf(c.get('db'), [sub])).get(sub) ?? langFrom(undefined);
    // ?kind=extra: the report of the tests the extra round paid (for those who paid it).
    const kind = c.req.query('kind') === 'extra' ? 'extra' : 'base';
    await requestReport(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id, sub, lang, undefined, kind);
    return c.json({ ok: true });
  });
  app.get('/:id/participants', zValidator('param', idParam), async (c) =>
    c.json(await listParticipants(c.get('db'), c.get('shopId'), c.req.valid('param').id)),
  );
  app.delete('/:id', zValidator('param', idParam), async (c) => {
    await deleteTesting(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.json({ ok: true });
  });

  return app;
}
