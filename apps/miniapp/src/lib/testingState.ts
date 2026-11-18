import { tierProgress, type Testing, type TierProgress } from '@tma-shop/shared';

/** How close a testing is to its next tier: few units left, or a small share of it. */
const HOT_UNITS = 3;
const HOT_SHARE = 0.15;

export interface ProductTestingState {
  testing: Testing;
  reached: TierProgress[];
  next: TierProgress | undefined;
  /** No tier yet, some reached, or close to the next one. */
  level: 'none' | 'reached' | 'hot';
  /** For sorting: how far from the next tier (share of it still missing; 2 = all reached). */
  distance: number;
}

/**
 * The most advanced open testing of a product (several when each variant has
 * its own): what it has reached and what it still needs.
 */
export function productTestingState(productId: string, testings: readonly Testing[]): ProductTestingState | null {
  const states = testings
    .filter((x) => x.productId === productId && x.status === 'open')
    .map((testing): ProductTestingState => {
      const progress = tierProgress(testing.tiers, testing.units);
      const reached = progress.filter((p) => p.reached);
      const next = progress.find((p) => !p.reached);
      const hot = next !== undefined && (next.missing <= HOT_UNITS || next.missing <= next.tier.units * HOT_SHARE);
      return {
        testing,
        reached,
        next,
        level: hot ? 'hot' : reached.length > 0 ? 'reached' : 'none',
        distance: next ? next.missing / next.tier.units : 2,
      };
    });
  if (states.length === 0) return null;
  return states.reduce((best, s) => (s.distance < best.distance ? s : best));
}
