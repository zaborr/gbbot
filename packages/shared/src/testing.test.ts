import { describe, expect, it } from 'vitest';
import { settleDraw, settleMoney, tierProgress, type TestingTier } from './testing.js';

const tiers: TestingTier[] = [
  { id: 'mp', name: 'M&P', cost: 20000, vials: 1 },
  { id: 'endo', name: 'Endo', cost: 10000, vials: 0 },
  { id: 'lcms', name: 'LCMS', cost: 15000, vials: 1 },
];

describe('testing tiers', () => {
  it('says how far each tier is and how many people it still needs', () => {
    // M&P needs 20 000 + one donor's 2 000 back; Endo 10 000 more.
    const [mp, endo] = tierProgress(tiers, 25000, 2000);
    expect(mp).toMatchObject({ reached: true, missing: 0, threshold: 22000 });
    expect(endo).toMatchObject({ reached: false, missing: 7000, people: 4 });
    expect(tierProgress(tiers, 21000, 2000)[0]).toMatchObject({ reached: false, missing: 1000, people: 1 });
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

describe('settling a testing', () => {
  const entries = [
    { orderId: 'a', amount: 2000, donor: true },
    { orderId: 'b', amount: 2000, donor: false },
    { orderId: 'c', amount: 2000, donor: false },
  ];

  it('gives donors all back and splits the leftover between the rest', () => {
    const { settlement, refunds } = settleMoney(entries, 2900, 200, false);
    expect(settlement).toMatchObject({ raised: 6000, donorRefunds: 2000, leftover: 1100, perPerson: 550 });
    expect(Object.fromEntries(refunds)).toEqual({ a: 2000, b: 550, c: 550 });
  });

  it('keeps a leftover below the threshold', () => {
    const { settlement, refunds } = settleMoney(entries, 3700, 200, false);
    expect(settlement.perPerson).toBe(0);
    expect(Object.fromEntries(refunds)).toEqual({ a: 2000 });
  });

  it('sends everything back when no tier was done', () => {
    const { refunds } = settleMoney(entries, 0, 200, true);
    expect(Object.fromEntries(refunds)).toEqual({ a: 2000, b: 2000, c: 2000 });
  });
});
