import { describe, expect, it } from 'vitest';
import { createTestingRequest, settleDraw, testingMaxUnits, tierProgress, type TestingTier } from './testing.js';

const tiers: TestingTier[] = [
  { id: 'hplc', name: 'HPLC', units: 10, cost: 20000, vials: 1 },
  { id: 'ms', name: 'MS', units: 20, cost: 10000, vials: 0 },
  { id: 'endo', name: 'Endotoxins', units: 40, cost: 15000, vials: 1 },
];

describe('testing tiers', () => {
  it('counts units: reached tiers, and how many units the rest still need', () => {
    const [hplc, ms, endo] = tierProgress(tiers, 23);
    expect(hplc).toMatchObject({ reached: true, missing: 0 });
    expect(ms).toMatchObject({ reached: true, missing: 0 });
    expect(endo).toMatchObject({ reached: false, missing: 17 });
    expect(testingMaxUnits(tiers)).toBe(40);
  });

  it('does the tiers reached while there are candidates for their vials', () => {
    const ranked = [{ ref: 'a' }, { ref: 'b' }];
    expect(settleDraw(tiers, 23, ranked)).toEqual({ tiersDone: ['hplc', 'ms'], donors: ['a'] });
    expect(settleDraw(tiers, 45, ranked)).toEqual({ tiersDone: ['hplc', 'ms', 'endo'], donors: ['a', 'b'] });
    // One candidate only: endotoxins would need a second vial.
    expect(settleDraw(tiers, 45, [{ ref: 'a' }])).toEqual({ tiersDone: ['hplc', 'ms'], donors: ['a'] });
    expect(settleDraw(tiers, 9, ranked)).toEqual({ tiersDone: [], donors: [] });
  });

  it('wants each tier to need more units than the one before', () => {
    const base = {
      productId: '8a6e0804-2bd0-4672-b79d-d97027f9071a',
      variantId: null,
      lab: 'Lab',
      contribution: 500,
      feeMode: 'mandatory' as const,
    };
    expect(createTestingRequest.safeParse({ ...base, tiers }).success).toBe(true);
    const unordered = [tiers[1]!, tiers[0]!];
    expect(createTestingRequest.safeParse({ ...base, tiers: unordered }).success).toBe(false);
  });
});
