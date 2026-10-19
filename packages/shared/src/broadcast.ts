import { z } from 'zod';

/**
 * Who gets a message to a GB's buyers:
 *  - `orders`: anyone with an order that is not cancelled;
 *  - `paid`: orders with something paid (paid, shipped, delivered);
 *  - `unpaid`: orders still waiting for a payment;
 *  - `cart`: people with products in their cart.
 */
export const broadcastAudience = z.enum(['orders', 'paid', 'unpaid', 'cart']);
export type BroadcastAudience = z.infer<typeof broadcastAudience>;

export const BROADCAST_MAX_LENGTH = 3500;

export const sendBroadcastRequest = z.object({
  audience: broadcastAudience,
  text: z.string().trim().min(1).max(BROADCAST_MAX_LENGTH),
});
export type SendBroadcastRequest = z.infer<typeof sendBroadcastRequest>;

/** A message sent to buyers, as listed in the GB's history. */
export const broadcastView = z.object({
  id: z.string(),
  audience: broadcastAudience,
  text: z.string(),
  /** "@ana" or the sender's name. */
  sender: z.string(),
  recipients: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  /** People the bot could not reach (they never pressed Start, or blocked it). */
  failed: z.number().int().nonnegative(),
  status: z.enum(['sending', 'done']),
  createdAt: z.string(),
});
export type BroadcastView = z.infer<typeof broadcastView>;
