import { describe, expect, it } from 'vitest';
import { createTestingRequest, settleDraw, tierSteps, unitValue, type TestingTier } from './testing.js';

const tiers: TestingTier[] = [
  { id: 'purity', name: 'Purity', cost: 10000, vials: 1 },
  { id: 'endo', name: 'Endotoxins', cost: 30000, vials: 0 },
  { id: 'metals', name: 'Metals', cost: 60000, vials: 1 },
];

describe('testing money', () => {
  it('turns money into units: the hidden part alone until there are enough orders', () => {
    expect(unitValue({ perUnit: 1000, contribution: 500, fees: 1500, units: 6, orders: 3 })).toBe(1000);
    // 12 orders, 30 units: 10 + 5 / 2.5 = 12 a unit.
    expect(unitValue({ perUnit: 1000, contribution: 500, fees: 6000, units: 30, orders: 12 })).toBe(1200);
    // No hidden part: a fee per unit.
    expect(unitValue({ perUnit: 0, contribution: 500, fees: 0, units: 0, orders: 0 })).toBe(500);
  });

  it('reaches tiers in order while the pot covers them and their vials', () => {
    // Vials at 45: purity needs 145, endotoxins 445 in all, metals 1095.
    const steps = tierSteps({ tiers, pot: 37000, vialPrice: 4500, unitValue: 1200 });
    expect(steps.map((s) => s.reached)).toEqual([true, false, false]);
    const endo = steps[1]!;
    expect(endo.needed).toBe(44500);
    expect(endo.missing).toBe(7500);
    // 75 missing at 12 a unit: about 7 units.
    expect(endo.unitsLeft).toBe(7);
    expect(endo.share).toBeCloseTo((37000 - 14500) / 30000);
    expect(steps[2]!.share).toBe(0);
  });

  it('never says no unit is left before a tier is covered', () => {
    const [purity] = tierSteps({ tiers, pot: 14400, vialPrice: 4500, unitValue: 1000 });
    expect(purity).toMatchObject({ reached: false, unitsLeft: 1 });
  });

  it('keeps what the draw did once it is done', () => {
    const steps = tierSteps({ tiers, pot: 0, vialPrice: 4500, unitValue: 1000, done: ['purity'] });
    expect(steps.map((s) => s.reached)).toEqual([true, false, false]);
    expect(steps.every((s) => s.unitsLeft === null)).toBe(true);
  });

  it('does the tiers reached while there are candidates for their vials', () => {
    const ranked = [{ ref: 'a' }, { ref: 'b' }];
    expect(settleDraw(tiers, ['purity', 'endo'], ranked)).toEqual({ tiersDone: ['purity', 'endo'], donors: ['a'] });
    expect(settleDraw(tiers, ['purity', 'endo', 'metals'], ranked)).toEqual({
      tiersDone: ['purity', 'endo', 'metals'],
      donors: ['a', 'b'],
    });
    // One candidate only: metals would need a second vial.
    expect(settleDraw(tiers, ['purity', 'endo', 'metals'], [{ ref: 'a' }])).toEqual({
      tiersDone: ['purity', 'endo'],
      donors: ['a'],
    });
    expect(settleDraw(tiers, [], ranked)).toEqual({ tiersDone: [], donors: [] });
  });

  it('wants tiers with distinct ids', () => {
    const base = {
      productId: '8a6e0804-2bd0-4672-b79d-d97027f9071a',
      variantId: null,
      lab: 'Lab',
      contribution: 500,
      perUnit: 1000,
      feeMode: 'mandatory' as const,
    };
    expect(createTestingRequest.safeParse({ ...base, tiers }).success).toBe(true);
    expect(createTestingRequest.safeParse({ ...base, tiers: [tiers[0]!, tiers[0]!] }).success).toBe(false);
  });
});

describe('testing upgrades', () => {
  const ladder: TestingTier[] = [
    { id: 'purity', name: 'Purity', cost: 10000, vials: 1 },
    { id: 'mass', name: 'Mass purity', cost: 25000, vials: 1, lab: 'Better lab', replaces: 'purity' },
    { id: 'endo', name: 'Endotoxins', cost: 5000, vials: 0 },
  ];

  it('reuses what the tier it upgrades costs, and marks that one as upgraded', () => {
    // Vials at 10: purity 110, mass 110 − 110 + 260 = 260, endotoxins 310.
    const below = tierSteps({ tiers: ladder, pot: 20000, vialPrice: 1000, unitValue: 1000 });
    expect(below.map((s) => s.needed)).toEqual([11000, 26000, 31000]);
    expect(below.map((s) => s.reached)).toEqual([true, false, false]);
    expect(below[0]?.upgradedTo).toBeNull();

    const above = tierSteps({ tiers: ladder, pot: 26000, vialPrice: 1000, unitValue: 1000 });
    expect(above[0]).toMatchObject({ reached: true, upgradedTo: expect.objectContaining({ id: 'mass' }) });
    expect(above[1]?.reached).toBe(true);
  });

  it('draws vials for the upgrade, not for what it replaces', () => {
    const ranked = [{ ref: 'a' }, { ref: 'b' }];
    expect(settleDraw(ladder, ['purity', 'mass', 'endo'], ranked)).toEqual({
      tiersDone: ['mass', 'endo'],
      donors: ['a'],
    });
    // Mass purity not reached: purity is done.
    expect(settleDraw(ladder, ['purity'], ranked)).toEqual({ tiersDone: ['purity'], donors: ['a'] });
  });

  it('wants an upgrade to replace one tier before it', () => {
    const base = {
      productId: '8a6e0804-2bd0-4672-b79d-d97027f9071a',
      variantId: null,
      lab: 'Lab',
      contribution: 500,
      perUnit: 0,
      feeMode: 'mandatory' as const,
    };
    expect(createTestingRequest.safeParse({ ...base, tiers: ladder }).success).toBe(true);
    const later = [{ ...ladder[0]!, replaces: 'mass' }, { ...ladder[1]!, replaces: null }];
    expect(createTestingRequest.safeParse({ ...base, tiers: later }).success).toBe(false);
  });
});

describe('text bar', () => {
  it('draws how far a tier is, in ten cells', async () => {
    const { textBar } = await import('./testing.js');
    expect(textBar(0.7)).toBe('▓▓▓▓▓▓▓░░░');
    expect(textBar(0)).toBe('░░░░░░░░░░');
    expect(textBar(1.4)).toBe('▓▓▓▓▓▓▓▓▓▓');
  });
});
