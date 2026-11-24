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
  /** Another lab than the testing's (null or missing: the testing's). */
  lab: z.string().trim().max(80).nullable().optional(),
  /**
   * An upgrade of an earlier tier (its id): once reached, that one is not done
   * and its cost goes towards this one.
   */
  replaces: z.string().max(40).nullable().optional(),
});
export type TestingTier = z.infer<typeof testingTier>;

/**
 * Someone put in a testing by hand who has not opened the bot yet (by
 * @username, lowercase, or Telegram id): they join when they first open it.
 * Left out of the draw if they have not by then.
 */
export interface TestingInvite {
  who: string;
  /** What they pay; null = the testing's fee. */
  amount: number | null;
  volunteer: boolean;
  notify: boolean;
  at: string;
}

export const MAX_TESTING_TIERS = 10;

/** Donations are whole units of the token (a line of a hidden product at 1 a unit). */
export const DONATION_UNIT = 100;
export const MAX_DONATION = 999 * DONATION_UNIT;
export const MAX_DONATION_HOURS = 168;

/** Giving to a testing once the GB is closed (whole units, added to the order to pay). */
export const addDonationRequest = z.object({
  testingId: z.uuid(),
  amount: z.number().int().min(DONATION_UNIT).max(MAX_DONATION).multipleOf(DONATION_UNIT),
});
export type AddDonationRequest = z.infer<typeof addDonationRequest>;

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
    (list) =>
      list.every((tier, i) => !tier.replaces || list.slice(0, i).some((before) => before.id === tier.replaces)) &&
      new Set(list.flatMap((tier) => (tier.replaces ? [tier.replaces] : []))).size ===
        list.filter((tier) => tier.replaces).length,
    'An upgrade replaces one tier before it, and each tier is upgraded once',
  );

/** What the organiser sets when creating it. */
export const createTestingRequest = z.object({
  productId: z.uuid(),
  /** Required when the product has variants: the one tested. */
  variantId: z.uuid().nullable(),
  lab: z.string().trim().min(1).max(80),
  /** The testing fee, paid once per buyer (minor units); 0: everyone takes part for free. */
  contribution: z.number().int().min(0).max(100_000_000),
  /** Hidden: what the organiser puts in the pot for each unit sold (minor units). */
  perUnit: z.number().int().min(0).max(100_000_000),
  feeMode: testingFeeMode,
  tiers,
  /** Hours buyers can give once the GB closes. */
  donationHours: z.number().int().min(0).max(MAX_DONATION_HOURS).default(48),
  /** Vials in each unit (a kit): a donor gives one of them. */
  vialsPerUnit: z.number().int().min(1).max(100).default(10),
  /** The extra round after the time to give, and the lowest cap to sign up (0: the fee). */
  extraEnabled: z.boolean().default(false),
  extraMin: z.number().int().min(0).max(100_000_000).default(0),
  /** 0: no sign-up of its own, it is shared out as soon as the time to give ends (caps are set during it). */
  extraSignupHours: z.number().int().min(0).max(MAX_DONATION_HOURS).default(0),
  extraPayHours: z.number().int().min(1).max(MAX_DONATION_HOURS).default(48),
  /** People who bought elsewhere can join from the GB, paying the same fee. */
  allowExternal: z.boolean().default(false),
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
  /** Its own lab, when not the testing's. */
  lab: string | null;
  /** The tier it upgrades, and the upgrade that replaced it (names). */
  upgrades: string | null;
  upgradedTo: string | null;
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
  /** The price of one vial (a unit's price ÷ its vials): what a donor gets back for it. */
  vialPrice: number;
  /** What one more unit sold adds, on average (used to turn money into units). */
  unitValue: number;
  /** Fees paid, what was paid on top of them, and the hidden part (units × per unit). */
  fees: number;
  extras: number;
  perUnitTotal: number;
  /** Given once the GB closed (orders paid). */
  donations: number;
  /** Paid in the extra round (only for the tests it covers; what is not used goes back). */
  extraPaid: number;
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

/** Where a testing is, for its organisers. */
export type TestingPhase = 'open' | 'window' | 'extra' | 'draw' | 'drawing' | 'lab' | 'done' | 'cancelled';
/**
 * What comes next: waiting for something (the GB to close, the time to give,
 * the extra round, the block, the lab) or something the organisers do.
 */
export type TestingStep =
  | 'wait_gb'
  | 'wait_window'
  | 'wait_extra'
  | 'unpaid'
  /** No test reached and the extra round never opened, or ended with nothing: open it (or close). */
  | 'extra'
  | 'draw'
  | 'wait_block'
  | 'vials'
  | 'wait_lab'
  | 'wait_report'
  | 'report'
  | 'settle';
export interface TestingNext {
  phase: TestingPhase;
  step: TestingStep | null;
  /** It needs the organisers now. */
  action: boolean;
  /** When what it waits for ends (ISO), if known. */
  until: string | null;
  /** People in it whose order is not paid yet. */
  unpaid: number;
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
  /** When the lab report was sent (and the extra round's one). */
  reportSentAt: z.string().nullable(),
  /** After the draw: vials sent to the lab, received there, results expected. */
  labProgress: z.custom<LabProgress>().nullable(),
  extraReportSentAt: z.string().nullable(),
  /** Hours to give once the GB closes, until when (set at closing), and whether one can give now. */
  donationHours: z.number().int(),
  vialsPerUnit: z.number().int(),
  /** Made once the GB was closed: the fee is paid to join (from an order), until the time to give ends. */
  posterior: z.boolean(),
  /** Those who did not buy it here can join (an order of only the fee). */
  /** This person offers a vial in it (each testing has its own draw). */
  volunteer: z.boolean(),
  allowExternal: z.boolean(),
  /** Those from outside can join now. */
  externalOpen: z.boolean(),
  extraEnabled: z.boolean(),
  /** The lowest cap to sign up to it (0: the fee), and its hours to sign up and to pay. */
  extraMin: z.number().int(),
  extraSignupHours: z.number().int(),
  extraPayHours: z.number().int(),
  /** The extra round, once it started (with money: what is missing is shown to those in it). */
  extra: z.custom<TestingExtraView>().nullable(),
  /**
   * Before the extra round opens (it is on, and the time to join lasts): who
   * already signed up with a cap, and what it would be now. Null otherwise.
   */
  extraPre: z.custom<TestingExtraView>().nullable(),
  donationsUntil: z.string().nullable(),
  donationsOpen: z.boolean(),
  /** The hidden product whose order lines are what was given. */
  donationProductId: z.string().nullable(),
  /** Only for the organiser. */
  money: z.custom<TestingMoney>().nullable(),
  /** Only for the organiser: people put in by hand who have not opened the bot yet. */
  invites: z.custom<TestingInvite[]>(),
  /** For the organisers' list: where it is and what comes next. */
  next: z.custom<TestingNext>().optional(),
});
export type Testing = z.infer<typeof testing>;

/** Someone taking part, for the organiser. */
/** Bought what is tested (an order not cancelled) and is not in the testing. */
export interface TestingNotJoined {
  userId: number;
  name: string;
  contact: string | null;
  units: number;
  /** Their latest order with it. */
  orderId: string;
  ref: string;
}

export interface TestingParticipant {
  orderId: string;
  /** The order's short id (as the draw publishes it). */
  ref: string;
  /** Bought elsewhere: an order of only the fee. */
  external: boolean;
  /** Drawn to give a vial. */
  donor: boolean;
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
  /** The pot it needs, with the tiers before it (an upgrade reuses what the tier it replaces costs). */
  needed: number;
  reached: boolean;
  /** Reached, but an upgrade of it was reached too: it is not done (nor paid). */
  upgradedTo: TestingTier | null;
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
  const own = new Map<string, number>();
  const steps = input.tiers.map((tier) => {
    const vialCost = tier.vials * input.vialPrice;
    // An upgrade: what the tier it replaces costs is used for it instead.
    const reused = tier.replaces ? (own.get(tier.replaces) ?? 0) : 0;
    const needed = before - reused + tier.cost + vialCost;
    own.set(tier.id, tier.cost + vialCost);
    const done = input.done ? input.done.includes(tier.id) : null;
    const reached = done ?? input.pot >= needed;
    const missing = reached ? 0 : Math.max(needed - input.pot, 0);
    const span = needed - before;
    const share = reached ? 1 : span > 0 ? Math.min(Math.max((input.pot - before) / span, 0), 1) : 0;
    const unitsLeft =
      reached || input.done ? null : input.unitValue > 0 ? Math.max(Math.ceil(missing / input.unitValue), 1) : null;
    before = needed;
    return { tier, cost: tier.cost, vialCost, needed, reached, upgradedTo: null as TestingTier | null, missing, share, unitsLeft };
  });
  // A tier whose upgrade was reached (or done) is upgraded, not done.
  for (const step of steps) {
    if (!step.tier.replaces) continue;
    const replaced = steps.find((s) => s.tier.id === step.tier.replaces);
    if (!replaced) continue;
    const upgraded = input.done ? input.done.includes(step.tier.id) : step.reached;
    if (upgraded) {
      replaced.upgradedTo = step.tier;
      replaced.reached = true;
      replaced.missing = 0;
      replaced.share = 1;
      replaced.unitsLeft = null;
    }
  }
  return steps;
}

/** One person who can be drawn to donate a vial (their order, published by its short id). */
export interface DrawCandidate {
  orderId: string;
  /** First 8 characters of the order id, as published (and hashed). */
  ref: string;
  /** Offered to donate. */
  volunteer: boolean;
  /** The price of one vial of what is tested on their order (unit price ÷ vials in it): a donor gets it back. */
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
  const upgradeOf = (id: string): TestingTier | undefined =>
    tiersList.find((tier) => tier.replaces === id && reached.includes(tier.id));
  let vials = 0;
  const done = new Set<string>();
  const skipped: TestingTier[] = [];
  for (const tier of tiersList) {
    if (!reached.includes(tier.id)) break;
    // Upgraded: its upgrade is done instead (unless that one cannot be).
    if (upgradeOf(tier.id)) {
      skipped.push(tier);
      continue;
    }
    if (vials + tier.vials > ranked.length) break;
    vials += tier.vials;
    done.add(tier.id);
  }
  // An upgrade that could not be done: the tier it replaced is done after all.
  for (const tier of skipped) {
    const up = upgradeOf(tier.id);
    if (up && done.has(up.id)) continue;
    if (vials + tier.vials > ranked.length) continue;
    vials += tier.vials;
    done.add(tier.id);
  }
  const tiersDone = tiersList.filter((tier) => done.has(tier.id)).map((tier) => tier.id);
  return { tiersDone, donors: ranked.slice(0, vials).map((c) => c.ref) };
}

/** A bar in text for bot messages: "▓▓▓▓▓▓▓░░░" for 0.7. */
export function textBar(share: number, width = 10): string {
  const full = Math.min(Math.max(Math.round(share * width), 0), width);
  return '▓'.repeat(full) + '░'.repeat(width - full);
}


/** The extra round as stored. */
export interface TestingExtraState {
  /** signup → pay → (someone did not pay: round, where the rest say if they go on → topup) → done. */
  stage: 'signup' | 'pay' | 'round' | 'topup' | 'done';
  /** In the second round: what is missing after someone did not pay. */
  gap?: number;
  /** When the stage ends. */
  until: string;
  /** Once shared out: the tests it is for, and the share of each one in. */
  target: string[];
  share: number;
  /** The pot when it was shared out: the extra round covers tests from there (later gifts go to the GB). */
  basePot?: number;
  reminded?: boolean;
  /** Once done: the tests it got, what was paid and what went back. */
  outcome?: { tiers: string[]; collected: number; refunded: number };
}

/** The extra round as the customer (or organiser) sees it. */
export interface TestingExtraView {
  /** `pre`: not open yet (the time to join and give lasts); one can already sign up with a cap. */
  stage: TestingExtraState['stage'] | 'pre';
  until: string;
  /** The lowest cap to sign up. */
  min: number;
  /** The tests not covered, in order, with what each one adds to what is missing. */
  missing: Array<{ id: string; name: string; amount: number }>;
  signed: number;
  /** The one asking, when signed up. */
  mine: { cap: number; share: number; state: string; orderId: string } | null;
  /** With those signed up now: the tests it would get and the share (null: none). */
  estimate: { tiers: string[]; share: number | null; out: boolean };
  outcome: TestingExtraState['outcome'] | null;
  /** Second round: what is missing, and what each would pay more depending on how many go on. */
  round: { gap: number; options: Array<{ count: number; amount: number }> } | null;
}

/** Going on (paying the difference) or leaving, in the second round of the extra round. */
/** Joining from outside: no order of the product here. */
export const joinExternalRequest = z.object({
  volunteer: z.boolean().default(false),
  contactUsername: z.string().trim().max(64).nullable().default(null),
});

export const extraRoundRequest = z.object({ testingId: z.uuid(), stay: z.boolean() });

/** Signing up to the extra round from an order, with a cap. */
export const extraSignupRequest = z.object({
  testingId: z.uuid(),
  cap: z.number().int().positive().max(100_000_000),
});

/**
 * Shares out what the tests still missing cost among those signed up: as many
 * tests as possible, in order, everyone in paying the same; whoever's cap is
 * below that share is out. `needs` is what is missing up to each test
 * (adding the ones before). Null when not even the first can be covered.
 */
export function shareOut<K>(
  people: ReadonlyArray<{ key: K; cap: number }>,
  needs: readonly number[],
): { count: number; share: number; keys: K[] } | null {
  for (let count = needs.length; count >= 1; count -= 1) {
    const need = needs[count - 1] ?? 0;
    if (need <= 0) return { count, share: 0, keys: [] };
    let inside = [...people];
    for (;;) {
      if (inside.length === 0) break;
      const share = Math.ceil(need / inside.length);
      const next = inside.filter((p) => p.cap >= share);
      if (next.length === inside.length) return { count, share, keys: inside.map((p) => p.key) };
      inside = next;
    }
  }
  return null;
}

/** A lab report kept (base or extra round), as organisers and participants list them. */
export interface TestingReportView {
  id: string;
  testingId: string;
  shopId: string;
  shopName: string;
  /** What was tested. */
  product: string;
  lab: string;
  kind: 'base' | 'extra';
  fileKind: 'document' | 'photo';
  fileName: string | null;
  /** The tiers of its round. */
  tiers: string[];
  createdAt: string;
  /** People it was sent to. */
  delivered: number;
  uploadedBy: string | null;
  /** A copy is kept (it can be opened here); else only through Telegram. */
  hasCopy: boolean;
}

/** Where the vials are after the draw (dates as ISO strings; `expected` a day, YYYY-MM-DD). */
export interface LabProgress {
  sentAt?: string;
  receivedAt?: string;
  expected?: string;
}

/** What the organiser marks: vials sent, vials received, or the day results are expected. */
export const labProgressRequest = z.discriminatedUnion('step', [
  z.object({ step: z.literal('sent') }),
  z.object({ step: z.literal('received') }),
  z.object({ step: z.literal('expected'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
]);
export type LabProgressRequest = z.infer<typeof labProgressRequest>;

/** One test a lab offers, with its price (minor units) and the vials it needs. */
export interface LabTest {
  id: string;
  name: string;
  cost: number;
  vials: number;
}

/** A lab a GB works with. */
export interface Lab {
  id: string;
  name: string;
  currency: string;
  tests: LabTest[];
  notes: string | null;
  updatedAt: string;
}

export const labRequest = z.object({
  name: z.string().trim().min(1).max(80),
  currency: z.string().trim().min(1).max(12),
  tests: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        name: z.string().trim().min(1).max(80),
        cost: z.number().int().positive().max(100_000_000),
        vials: z.number().int().min(0).max(20),
      }),
    )
    .max(30),
  notes: z.string().trim().max(500).nullable().default(null),
});
export type LabRequest = z.infer<typeof labRequest>;
