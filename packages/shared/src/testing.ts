import { z } from 'zod';

/**
 * Collective lab testing of one product (or one variant): buyers pay a testing
 * fee once (whatever the quantity), and each tier (a lab test) is done when
 * enough units have been bought by people who paid it. Nothing goes back if
 * no tier is reached; what is left over stays with the organiser.
 */

/** One lab test: the units needed, what it costs and how many vials it needs. */
export const testingTier = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  /** Units (bought by people who paid the fee) needed for it. */
  units: z.number().int().positive().max(100_000),
  /** What the lab charges, in minor units of the testing's currency. */
  cost: z.number().int().positive().max(100_000_000),
  /** Vials it needs (0 when it reuses another tier's vial). */
  vials: z.number().int().min(0).max(20),
});
export type TestingTier = z.infer<typeof testingTier>;

export const MAX_TESTING_TIERS = 10;

/**
 * Who pays the fee: every buyer, only those who choose to, or every buyer but
 * VIPs (they see every result for free).
 */
export const testingFeeMode = z.enum(['mandatory', 'optional', 'mandatory_non_vip']);
export type TestingFeeMode = z.infer<typeof testingFeeMode>;

export const testingStatus = z.enum(['open', 'closed', 'drawing', 'drawn', 'settled', 'cancelled']);
export type TestingStatus = z.infer<typeof testingStatus>;

const tiers = z
  .array(testingTier)
  .min(1)
  .max(MAX_TESTING_TIERS)
  .refine((list) => new Set(list.map((tier) => tier.id)).size === list.length, 'Repeated tier')
  .refine(
    (list) => list.every((tier, i) => i === 0 || tier.units > (list[i - 1]?.units ?? 0)),
    'Each tier needs more units than the one before',
  );

/** What the organiser sets when creating it. */
export const createTestingRequest = z.object({
  productId: z.uuid(),
  /** Required when the product has variants: the one tested. */
  variantId: z.uuid().nullable(),
  lab: z.string().trim().min(1).max(80),
  /** The testing fee, paid once per buyer (minor units). */
  contribution: z.number().int().positive().max(100_000_000),
  feeMode: testingFeeMode,
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
  /** The testing fee (minor units). */
  contribution: z.number().int(),
  feeMode: testingFeeMode,
  tiers: z.array(testingTier),
  status: testingStatus,
  /** Units bought by people who paid the fee (orders paid), and on orders not paid yet. */
  units: z.number().int(),
  pendingUnits: z.number().int(),
  /** Fees paid so far (minor units), and how many people paid them. */
  raised: z.number().int(),
  participants: z.number().int(),
  /** For the customer asking: already in it (on an order). */
  joined: z.boolean(),
  /** For the customer asking: a VIP who does not pay the fee here (and sees every result). */
  exempt: z.boolean(),
  /** The draw of donors, once launched. */
  draw: z.custom<TestingDraw>().nullable(),
  /** When the lab report was sent. */
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
  /** Units of the tested product on the order. */
  units: number;
  /** Their whole order is paid. */
  paid: boolean;
  volunteer: boolean;
  /** A VIP who does not pay the fee (here only to donate). */
  exempt: boolean;
}

export const updateTestingEnabledRequest = z.object({ enabled: z.boolean() });

/** Where the units bought stand against the tiers, in order. */
export interface TierProgress {
  tier: TestingTier;
  reached: boolean;
  /** Units still missing to reach it (0 when reached). */
  missing: number;
}

export function tierProgress(tiersList: readonly TestingTier[], units: number): TierProgress[] {
  return tiersList.map((tier) => ({
    tier,
    reached: units >= tier.units,
    missing: Math.max(tier.units - units, 0),
  }));
}

/** The units of the last tier (the end of the progress bar). */
export function testingMaxUnits(tiersList: readonly TestingTier[]): number {
  return tiersList.reduce((max, tier) => Math.max(max, tier.units), 0);
}

/** One person who can be drawn to donate a vial (their order, published by its short id). */
export interface DrawCandidate {
  orderId: string;
  /** First 8 characters of the order id, as published (and hashed). */
  ref: string;
  /** Offered to donate. */
  volunteer: boolean;
  /** The price of one unit of what is tested on their order: a donor gets it back. */
  vialPrice: number;
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
 * Which tiers are done and who donates, once the candidates are ranked: the
 * tiers reached with the units bought, in order, while there are enough
 * candidates for their vials. The donors are the first ones in the ranking,
 * one per vial.
 */
export function settleDraw(
  tiersList: readonly TestingTier[],
  units: number,
  ranked: ReadonlyArray<Pick<DrawCandidate, 'ref'>>,
): { tiersDone: string[]; donors: string[] } {
  let vials = 0;
  const done: string[] = [];
  for (const tier of tiersList) {
    if (units < tier.units || vials + tier.vials > ranked.length) break;
    vials += tier.vials;
    done.push(tier.id);
  }
  return { tiersDone: done, donors: ranked.slice(0, vials).map((c) => c.ref) };
}
