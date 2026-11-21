import { z } from 'zod';

/**
 * Who gets a message to a GB's buyers:
 *  - `orders`: anyone with an order that is not cancelled;
 *  - `paid`: orders with something paid (paid, shipped, delivered);
 *  - `unpaid`: orders still waiting for a payment;
 *  - `cart`: people with products in their cart;
 *  - `testing`: those taking part in one testing (people from outside too);
 *  - `donors`: one testing's vial donors (its volunteers, before the draw).
 * `paid` leaves out orders from outside: they only took part in a testing.
 */
export const broadcastAudience = z.enum(['orders', 'paid', 'unpaid', 'cart', 'testing', 'donors']);
export type BroadcastAudience = z.infer<typeof broadcastAudience>;

export const BROADCAST_MAX_LENGTH = 3500;

/** The audiences about one testing. */
export const TESTING_AUDIENCES: readonly BroadcastAudience[] = ['testing', 'donors'];

export const sendBroadcastRequest = z.object({
  audience: broadcastAudience,
  /** For `testing` and `donors`: which testing. */
  testingId: z.uuid().nullable().default(null),
  text: z.string().trim().min(1).max(BROADCAST_MAX_LENGTH),
});
export type SendBroadcastRequest = z.infer<typeof sendBroadcastRequest>;

/** A message sent to buyers, as listed in the GB's history. */
/** Someone the bot cannot write to: never pressed Start, or blocked it. */
export const unreachedPerson = z.object({
  telegramId: z.number().int(),
  name: z.string(),
  username: z.string().nullable(),
  /** Their last order in the GB (its short id), to find them without a username. */
  orderRef: z.string().nullable(),
});
export type UnreachedPerson = z.infer<typeof unreachedPerson>;

export const broadcastView = z.object({
  id: z.string(),
  audience: broadcastAudience,
  /** For a testing's audiences: what it tests. */
  testing: z.string().nullable(),
  text: z.string(),
  /** "@ana" or the sender's name. */
  sender: z.string(),
  recipients: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  /** People the bot could not reach (they never pressed Start, or blocked it). */
  failed: z.number().int().nonnegative(),
  /** Who those are, so the organisers can write to them themselves. */
  unreached: z.array(unreachedPerson),
  status: z.enum(['sending', 'done']),
  createdAt: z.string(),
});
export type BroadcastView = z.infer<typeof broadcastView>;
