import { describe, expect, it } from 'vitest';
import { settleDraw, tierProgress, type TestingTier } from './testing.js';

const tiers: TestingTier[] = [
  { id: 'mp', name: 'M&P', cost: 20000, vials: 1 },
  { id: 'endo', name: 'Endo', cost: 10000, vials: 0 },
  { id: 'lcms', name: 'LCMS', cost: 15000, vials: 1 },
];

describe('testing tiers', () => {
  it('says how far each tier is and how many people it still needs', () => {
    const [mp, endo] = tierProgress(tiers, 25000, 2000);
    expect(mp).toMatchObject({ reached: true, missing: 0 });
    expect(endo).toMatchObject({ reached: false, missing: 5000, people: 3 });
  });

  it('takes tiers while the money, less what donors get back, covers them', () => {
    const ranked = [
      { ref: 'a', paid: 2000 },
      { ref: 'b', paid: 0 },
      { ref: 'c', paid: 2000 },
    ];
    // 46 000 raised: M&P + Endo + LCMS cost 45 000, but two donors get 2 000 back.
    expect(settleDraw(tiers, 46000, ranked)).toEqual({ tiersDone: ['mp', 'endo'], donors: ['a'] });
    // With the second donor not having paid, LCMS fits.
    expect(settleDraw(tiers, 47000, ranked)).toEqual({ tiersDone: ['mp', 'endo', 'lcms'], donors: ['a', 'b'] });
  });

  it('leaves out a tier whose vials nobody can give', () => {
    expect(settleDraw(tiers, 100000, [{ ref: 'a', paid: 0 }])).toEqual({
      tiersDone: ['mp', 'endo'],
      donors: ['a'],
    });
    expect(settleDraw(tiers, 100000, [])).toEqual({ tiersDone: [], donors: [] });
  });
});
