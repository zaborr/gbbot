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
});
export type Testing = z.infer<typeof testing>;

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
    threshold += tier.cost;
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
