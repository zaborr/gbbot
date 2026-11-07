import { z } from 'zod';

/**
 * Collective lab testing of one product (or one of its variants): buyers pay a
 * contribution on their order, and each tier (a lab test) is ordered once the
 * money raised covers it.
 */

/** One lab test: what it costs and how many vials it needs. */
export const testingTier = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  /** What the lab charges, in minor units of the testing's currency. */
  cost: z.number().int().positive().max(100_000_000),
  /** Vials it needs (0 when it reuses another tier's vial). */
  vials: z.number().int().min(0).max(20),
  /** What the lab finally charged (set when settling). */
  realCost: z.number().int().nonnegative().max(100_000_000).optional(),
  /** Added when settling, paid with the leftover. */
  extra: z.boolean().optional(),
});
export type TestingTier = z.infer<typeof testingTier>;

export const MAX_TESTING_TIERS = 10;
/** Below this per person, the leftover is not sent back (fees would eat it). */
export const DEFAULT_REFUND_THRESHOLD = 200;

export const testingStatus = z.enum(['open', 'closed', 'drawing', 'drawn', 'settled', 'cancelled']);
export type TestingStatus = z.infer<typeof testingStatus>;

const tiers = z
  .array(testingTier)
  .min(1)
  .max(MAX_TESTING_TIERS)
  .refine((list) => new Set(list.map((tier) => tier.id)).size === list.length, 'Repeated tier');

/** What the organiser sets when creating it. */
export const createTestingRequest = z.object({
  productId: z.uuid(),
  /** Required when the product has variants: the one tested. */
  variantId: z.uuid().nullable(),
  lab: z.string().trim().min(1).max(80),
  /** The most each participant pays (minor units). */
  contribution: z.number().int().positive().max(100_000_000),
  refundThreshold: z.number().int().nonnegative().max(100_000_000),
  tiers,
});
export type CreateTestingRequest = z.infer<typeof createTestingRequest>;

/** Editing: the product and variant stay as they were. */
export const updateTestingRequest = createTestingRequest.omit({ productId: true, variantId: true });
export type UpdateTestingRequest = z.infer<typeof updateTestingRequest>;

export const testing = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable(),
  /** Product title and variant label, for display. */
  productTitle: z.string(),
  variantLabel: z.string().nullable(),
  currency: z.string(),
  lab: z.string(),
  contribution: z.number().int(),
  refundThreshold: z.number().int(),
  tiers: z.array(testingTier),
  status: testingStatus,
  /** Paid contributions so far (minor units), and how many people paid. */
  raised: z.number().int(),
  participants: z.number().int(),
  /** Contributions ordered but not paid yet. */
  pending: z.number().int(),
  /** For the customer asking: already in it (on an order). */
  joined: z.boolean(),
  /** The draw of donors, once launched. */
  draw: z.custom<TestingDraw>().nullable(),
  /** How the money was worked out, once settled. */
  settlement: z.custom<TestingSettlement>().nullable(),
  /** When the lab report was sent to the participants. */
  reportSentAt: z.string().nullable(),
});
export type Testing = z.infer<typeof testing>;

/** Someone taking part, for the organiser. */
export interface TestingParticipant {
  orderId: string;
  name: string;
  /** Telegram @ given on the order (or their username). */
  contact: string | null;
  amount: number;
  /** Their whole order is paid. */
  paid: boolean;
  volunteer: boolean;
}

/** Settling: the real cost of each tier done, and maybe an extra tier paid with the leftover. */
export const settleTestingRequest = z.object({
  realCosts: z.record(z.string(), z.number().int().nonnegative().max(100_000_000)),
  extra: z
    .object({ name: z.string().trim().min(1).max(60), cost: z.number().int().positive().max(100_000_000) })
    .optional(),
});
export type SettleTestingRequest = z.infer<typeof settleTestingRequest>;

/** What settling gives (shown before confirming). */
export interface SettlePreview {
  settlement: Omit<TestingSettlement, 'at'>;
  /** Short order id → what goes back. */
  refunds: Record<string, number>;
}

export const updateTestingEnabledRequest = z.object({ enabled: z.boolean() });

/** Where the money raised stands against the tiers, in order. */
export interface TierProgress {
  tier: TestingTier;
  /** Cumulative cost up to this tier. */
  threshold: number;
  reached: boolean;
  /** Still missing to reach it (0 when reached). */
  missing: number;
  /** People still needed at the current contribution (0 when reached). */
  people: number;
}

export function tierProgress(
  tiersList: readonly TestingTier[],
  raised: number,
  contribution: number,
): TierProgress[] {
  let threshold = 0;
  return tiersList.map((tier) => {
    // Donors get their contribution back, so each vial needs one more.
    threshold += tier.cost + tier.vials * contribution;
    const missing = Math.max(threshold - raised, 0);
    return {
      tier,
      threshold,
      reached: missing === 0,
      missing,
      people: contribution > 0 ? Math.ceil(missing / contribution) : 0,
    };
  });
}

/** Total cost of every tier. */
export function testingTotalCost(tiersList: readonly TestingTier[]): number {
  return tiersList.reduce((sum, tier) => sum + tier.cost, 0);
}

/** What has to be raised for every tier: their cost plus what goes back to the donors. */
export function testingTarget(tiersList: readonly TestingTier[], contribution: number): number {
  return tiersList.reduce((sum, tier) => sum + tier.cost + tier.vials * contribution, 0);
}

/** One person who can be drawn to donate a vial (their order, published by its short id). */
export interface DrawCandidate {
  orderId: string;
  /** First 8 characters of the order id, as published (and hashed). */
  ref: string;
  /** Offered to donate. */
  volunteer: boolean;
  /** What they paid for the testing (0 if they did not take part): a donor gets it back. */
  paid: number;
}

/**
 * The draw of a testing: the block that decides it, who could be drawn and the
 * result. Saved when it is launched, completed when the block is mined.
 */
export interface TestingDraw {
  /** The first block after the announcement. */
  height: number;
  hash: string | null;
  announcedAt: string;
  drawnAt: string | null;
  candidates: DrawCandidate[];
  /** After the draw: volunteers first, then everyone else, each group by its hash. */
  ranking: string[];
  /** Short order ids of the donors, in draw order. */
  donors: string[];
  /** Tiers done (ids) with those donors. */
  tiersDone: string[];
  /** Earlier draws, cancelled when the GB was opened again. */
  history?: Array<{ height: number; hash: string | null; donors: string[]; cancelledAt: string }>;
}

/**
 * Which tiers can be done and who donates, once the candidates are ranked:
 * tiers are taken in order while the money raised (less what goes back to the
 * donors taking part) covers them and there are enough candidates for their
 * vials. The donors are the first ones in the ranking, one per vial.
 */
export function settleDraw(
  tiersList: readonly TestingTier[],
  raised: number,
  ranked: ReadonlyArray<Pick<DrawCandidate, 'ref' | 'paid'>>,
): { tiersDone: string[]; donors: string[] } {
  let cost = 0;
  let vials = 0;
  const done: string[] = [];
  for (const tier of tiersList) {
    const nextCost = cost + tier.cost;
    const nextVials = vials + tier.vials;
    if (nextVials > ranked.length) break;
    const refunds = ranked.slice(0, nextVials).reduce((sum, c) => sum + c.paid, 0);
    if (nextCost > raised - refunds) break;
    cost = nextCost;
    vials = nextVials;
    done.push(tier.id);
  }
  return { tiersDone: done, donors: ranked.slice(0, vials).map((c) => c.ref) };
}

/** The money of a settled testing. */
export interface TestingSettlement {
  at: string;
  /** Paid contributions. */
  raised: number;
  /** What the tiers done cost (real cost where set). */
  spent: number;
  /** Given back to donors who had paid (their testing is free). */
  donorRefunds: number;
  /** What is left for the others, before rounding and the threshold. */
  leftover: number;
  /** Sent back to each participant who paid (0 when below the threshold). */
  perPerson: number;
  /** No tier was reached: everything goes back. */
  allBack: boolean;
}

export interface SettleEntry {
  orderId: string;
  amount: number;
  donor: boolean;
}

/**
 * What goes back to each participant. Donors who paid get it all back; the
 * leftover (raised − cost − donors) is split in equal parts between the rest,
 * unless that is below the threshold. With no tier done, everyone gets it all.
 */
export function settleMoney(
  entries: readonly SettleEntry[],
  spent: number,
  threshold: number,
  allBack: boolean,
): { settlement: Omit<TestingSettlement, 'at'>; refunds: Map<string, number> } {
  const refunds = new Map<string, number>();
  const raised = entries.reduce((sum, e) => sum + e.amount, 0);
  if (allBack) {
    for (const e of entries) refunds.set(e.orderId, e.amount);
    return {
      settlement: { raised, spent: 0, donorRefunds: 0, leftover: raised, perPerson: 0, allBack: true },
      refunds,
    };
  }
  const donors = entries.filter((e) => e.donor);
  const payers = entries.filter((e) => !e.donor);
  const donorRefunds = donors.reduce((sum, e) => sum + e.amount, 0);
  for (const e of donors) if (e.amount > 0) refunds.set(e.orderId, e.amount);
  const leftover = payers.reduce((sum, e) => sum + e.amount, 0) - spent;
  const share = payers.length > 0 ? Math.floor(Math.max(leftover, 0) / payers.length) : 0;
  const perPerson = share >= Math.max(threshold, 1) ? share : 0;
  if (perPerson > 0) for (const e of payers) refunds.set(e.orderId, Math.min(perPerson, e.amount));
  return { settlement: { raised, spent, donorRefunds, leftover, perPerson, allBack: false }, refunds };
}
