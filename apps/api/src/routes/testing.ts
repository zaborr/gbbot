import { closeExtraPay, decideExtra, openExtra, remindExtraNow } from '../services/testingExtra.js';
import { announceNewTesting, moveTestingWindow, reopenTesting } from '../services/testingDonations.js';
import { Hono } from 'hono';
import { withNext } from '../services/testingNext.js';
import { inviteNotJoined, listNotJoined, remindUnpaid } from '../services/testingRemind.js';
import { addParticipant, removeInvite } from '../services/testingAdd.js';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createTestingRequest, labProgressRequest, langFrom, MAX_DONATION_HOURS, updateTestingRequest   decideExtraRequest,
  openExtraRequest,
} from '@tma-shop/shared';
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

  // Each with where it is and what comes next (the organisers' panel).
  app.get('/', async (c) =>
    c.json(await withNext(c.get('db'), c.get('shop'), await listTestings(c.get('db'), c.get('shopId')))),
  );
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
  // Opening the payment round by hand (its kind; among everyone, how many tests).
  app.post('/:id/extra', zValidator('param', idParam), zValidator('json', openExtraRequest), async (c) => {
    await openExtra(c.get('db'), c.get('env'), c.get('shopId'), c.req.valid('param').id, c.req.valid('json'));
    return c.json({ ok: true });
  });
  // While paying: remind those who have not paid, or close paying.
  app.post('/:id/extra/remind', zValidator('param', idParam), async (c) =>
    c.json(await remindExtraNow(c.get('db'), c.get('env'), c.get('shopId'), c.req.valid('param').id)),
  );
  app.post('/:id/extra/close', zValidator('param', idParam), async (c) => {
    await closeExtraPay(c.get('db'), c.get('env'), c.get('shopId'), c.req.valid('param').id);
    return c.json({ ok: true });
  });
  // Closed with shares unpaid: what follows.
  app.post('/:id/extra/decide', zValidator('param', idParam), zValidator('json', decideExtraRequest), async (c) => {
    await decideExtra(c.get('db'), c.get('env'), c.get('shopId'), c.req.valid('param').id, c.req.valid('json').choice);
    return c.json({ ok: true });
  });
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
  // Someone put in by hand (a buyer, or anyone from outside), until the draw.
  app.post(
    '/:id/participants',
    zValidator('param', idParam),
    zValidator(
      'json',
      z.object({
        who: z.string().trim().min(1).max(64),
        amount: z.number().int().nonnegative().max(100_000_000).nullable().default(null),
        volunteer: z.boolean().default(false),
        notify: z.boolean().default(true),
      }),
    ),
    async (c) =>
      c.json(
        await addParticipant(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id, c.req.valid('json')),
        201,
      ),
  );
  // Taking back someone kept for when they open the bot.
  app.delete(
    '/:id/invites/:who',
    zValidator('param', z.object({ id: z.uuid(), who: z.string().min(1).max(64) })),
    async (c) => {
      const { id, who } = c.req.valid('param');
      await removeInvite(c.get('db'), c.get('shop'), id, who);
      return c.json({ ok: true });
    },
  );
  // Those who bought what is tested and are not in it; and inviting them through the bot.
  app.get('/:id/not-joined', zValidator('param', idParam), async (c) =>
    c.json(await listNotJoined(c.get('db'), c.get('shop'), c.req.valid('param').id)),
  );
  app.post('/:id/invite-buyers', zValidator('param', idParam), async (c) =>
    c.json(await inviteNotJoined(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id)),
  );
  // A message through the bot to those whose order is not paid yet, with a button to it.
  app.post('/:id/remind', zValidator('param', idParam), async (c) =>
    c.json(await remindUnpaid(c.get('db'), c.get('env'), c.get('shop'), c.req.valid('param').id)),
  );
  app.delete('/:id', zValidator('param', idParam), async (c) => {
    await deleteTesting(c.get('db'), c.get('shopId'), c.req.valid('param').id);
    return c.json({ ok: true });
  });

  return app;
}
