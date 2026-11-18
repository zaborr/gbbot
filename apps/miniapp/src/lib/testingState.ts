import type { Testing, TestingTierView } from '@tma-shop/shared';

/** How close a testing is to its next tier: few units left, or most of it covered. */
const HOT_UNITS = 3;
const HOT_SHARE = 0.85;

export interface ProductTestingState {
  testing: Testing;
  reached: TestingTierView[];
  next: TestingTierView | undefined;
  /** No tier yet, some reached, or close to the next one. */
  level: 'none' | 'reached' | 'hot';
  /** For sorting: how far from the next tier (share of it still missing; 2 = all reached). */
  distance: number;
}

/** The tiers reached and the next one, of one testing. */
export function testingState(testing: Testing): Omit<ProductTestingState, 'testing'> {
  const reached = testing.tiers.filter((tier) => tier.reached);
  const next = testing.tiers.find((tier) => !tier.reached);
  const hot =
    next !== undefined && ((next.unitsLeft !== null && next.unitsLeft <= HOT_UNITS) || next.share >= HOT_SHARE);
  return {
    reached,
    next,
    level: hot ? 'hot' : reached.length > 0 ? 'reached' : 'none',
    distance: next ? 1 - next.share : 2,
  };
}

/**
 * The most advanced open testing of a product (several when each variant has
 * its own): what it has reached and what it still needs.
 */
export function productTestingState(productId: string, testings: readonly Testing[]): ProductTestingState | null {
  const states = testings
    .filter((x) => x.productId === productId && x.status === 'open')
    .map((testing): ProductTestingState => ({ testing, ...testingState(testing) }));
  if (states.length === 0) return null;
  return states.reduce((best, s) => (s.distance < best.distance ? s : best));
}

/** "about 17 units" when known, otherwise how much of the tier is covered. */
export const sharePercent = (tier: Pick<TestingTierView, 'share'>): number => Math.floor(tier.share * 100);
