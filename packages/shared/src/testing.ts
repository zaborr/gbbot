import { z } from 'zod';

/**
 * Collective lab testing of one product (or one variant). Everything is money:
 * the pot is the fees paid (and anything paid on top), plus a hidden amount
 * per unit sold that the organiser puts in from the price. Tiers (lab tests)
 * are done in order while the pot covers them (their cost and the vials given
 * back). Customers never see money: only how far each tier is and roughly how
 * many units are still missing. Nothing goes back if no tier is reached; what
 * is left over stays with the organiser.
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
  .refine((list) => new Set(list.map((tier) => tier.id)).size === list.length, 'Repeated tier');

/** What the organiser sets when creating it. */
export const createTestingRequest = z.object({
  productId: z.uuid(),
  /** Required when the product has variants: the one tested. */
  variantId: z.uuid().nullable(),
  lab: z.string().trim().min(1).max(80),
  /** The testing fee, paid once per buyer (minor units). */
  contribution: z.number().int().positive().max(100_000_000),
  /** Hidden: what the organiser puts in the pot for each unit sold (minor units). */
  perUnit: z.number().int().min(0).max(100_000_000),
  feeMode: testingFeeMode,
  tiers,
});
export type CreateTestingRequest = z.infer<typeof createTestingRequest>;

/** Editing: the product and variant stay as they were. */
export const updateTestingRequest = createTestingRequest.omit({ productId: true, variantId: true });
export type UpdateTestingRequest = z.infer<typeof updateTestingRequest>;

/** What customers see of a tier: no money, only how far it is. */
export interface TestingTierView {
  id: string;
  name: string;
  vials: number;
  reached: boolean;
  /** Its share covered so far (0 to 1), from where the tier before ends. */
  share: number;
  /** Roughly how many units are still missing (null when reached, or unknown). */
  unitsLeft: number | null;
}

/** The money of a testing, for the organiser only. */
export interface TestingMoney {
  perUnit: number;
  /** The tiers as set (with their cost). */
  tiers: TestingTier[];
  /** The price of one unit of what is tested: what a donor gets back for a vial. */
  vialPrice: number;
  /** What one more unit sold adds, on average (used to turn money into units). */
  unitValue: number;
  /** Fees paid, what was paid on top of them, and the hidden part (units × per unit). */
  fees: number;
  extras: number;
  perUnitTotal: number;
  pot: number;
  /** Units sold (orders paid), and on orders not paid yet. */
  units: number;
  pendingUnits: number;
  /** Orders paid with what is tested, and how many of them paid the fee. */
  orders: number;
  payers: number;
  /** People on it, paid or not (once there is one, the fee cannot change). */
  entries: number;
  /** Per tier: its cost with vials, the pot it needs (adding the ones before), and what is missing. */
  steps: Array<{ id: string; cost: number; vialCost: number; needed: number; missing: number }>;
  /** The pot after paying the tiers reached (and their vials). */
  balance: number;
}

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
  tiers: z.array(z.custom<TestingTierView>()),
  status: testingStatus,
  /** People who paid the fee. */
  participants: z.number().int(),
  /** For the customer asking: already in it (on an order). */
  joined: z.boolean(),
  /** For the customer asking: a VIP who does not pay the fee here (and sees every result). */
  exempt: z.boolean(),
  /** The draw of donors, once launched. */
  draw: z.custom<TestingDraw>().nullable(),
  /** When the lab report was sent. */
  reportSentAt: z.string().nullable(),
  /** Only for the organiser. */
  money: z.custom<TestingMoney>().nullable(),
});
export type Testing = z.infer<typeof testing>;

/** Someone taking part, for the organiser. */
export interface TestingParticipant {
  orderId: string;
  name: string;
  /** Telegram @ given on the order (or their username). */
  contact: string | null;
  /** What they pay into it: the fee, plus anything on top. */
  amount: number;
  extra: number;
  /** Units of the tested product on the order. */
  units: number;
  /** Their whole order is paid. */
  paid: boolean;
  volunteer: boolean;
  /** A VIP who does not pay the fee (here only to donate). */
  exempt: boolean;
}

export const updateTestingEnabledRequest = z.object({ enabled: z.boolean() });

/** Orders needed before their average says what a unit adds; until then, only the hidden part. */
export const UNIT_VALUE_MIN_ORDERS = 5;

/**
 * What one more unit sold adds to the pot, roughly: the hidden part, plus the
 * fees paid so far spread over the units sold (once there are enough orders).
 * Without a hidden part, a fee per unit.
 */
export function unitValue(input: {
  perUnit: number;
  contribution: number;
  fees: number;
  units: number;
  orders: number;
}): number {
  if (input.orders >= UNIT_VALUE_MIN_ORDERS && input.units > 0) {
    return input.perUnit + input.fees / input.units;
  }
  return input.perUnit > 0 ? input.perUnit : input.contribution;
}

/** Where each tier stands against the pot, in order. */
export interface TierStep {
  tier: TestingTier;
  /** Its cost and the vials given back for it. */
  cost: number;
  vialCost: number;
  /** The pot it needs, with the tiers before it. */
  needed: number;
  reached: boolean;
  missing: number;
  share: number;
  unitsLeft: number | null;
}

/**
 * The tiers against the pot: each is reached once the pot covers it and the
 * ones before. `done` (after the draw) fixes which ones were done instead.
 */
export function tierSteps(input: {
  tiers: readonly TestingTier[];
  pot: number;
  vialPrice: number;
  unitValue: number;
  done?: readonly string[] | null;
}): TierStep[] {
  let before = 0;
  return input.tiers.map((tier) => {
    const vialCost = tier.vials * input.vialPrice;
    const needed = before + tier.cost + vialCost;
    const reached = input.done ? input.done.includes(tier.id) : input.pot >= needed;
    const missing = reached ? 0 : Math.max(needed - input.pot, 0);
    const span = needed - before;
    const share = reached ? 1 : span > 0 ? Math.min(Math.max((input.pot - before) / span, 0), 1) : 0;
    const unitsLeft =
      reached || input.done ? null : input.unitValue > 0 ? Math.max(Math.ceil(missing / input.unitValue), 1) : null;
    before = needed;
    return { tier, cost: tier.cost, vialCost, needed, reached, missing, share, unitsLeft };
  });
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
 * tiers the pot reached, in order, while there are enough candidates for their
 * vials. The donors are the first ones in the ranking, one per vial.
 */
export function settleDraw(
  tiersList: readonly TestingTier[],
  reached: readonly string[],
  ranked: ReadonlyArray<Pick<DrawCandidate, 'ref'>>,
): { tiersDone: string[]; donors: string[] } {
  let vials = 0;
  const done: string[] = [];
  for (const tier of tiersList) {
    if (!reached.includes(tier.id) || vials + tier.vials > ranked.length) break;
    vials += tier.vials;
    done.push(tier.id);
  }
  return { tiersDone: done, donors: ranked.slice(0, vials).map((c) => c.ref) };
}
