import { describe, expect, it } from 'vitest';
import type { Testing } from '@tma-shop/shared';
import { digestLines, madridNow } from './testingDigest.js';

const testing = (patch: Partial<Testing>): Testing =>
  ({ productTitle: 'Sencha', variantLabel: null, status: 'closed', ...patch }) as Testing;

describe('the daily testing digest', () => {
  it('lists only what needs the organisers', () => {
    const lines = digestLines('es', [
      testing({ next: { phase: 'draw', step: 'draw', action: true, until: null, unpaid: 0 } }),
      testing({ variantLabel: '50 g', next: { phase: 'draw', step: 'unpaid', action: true, until: null, unpaid: 3 } }),
      testing({ next: { phase: 'window', step: 'wait_window', action: false, until: null, unpaid: 0 } }),
      testing({ status: 'settled', next: { phase: 'done', step: null, action: false, until: null, unpaid: 0 } }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Sencha');
    expect(lines[1]).toContain('Sencha · 50 g');
    expect(lines[1]).toContain('3');
  });

  it('goes by the time in Madrid', () => {
    expect(madridNow(new Date('2026-11-21T08:30:00Z'))).toEqual({ day: '2026-11-21', hour: 9 });
    expect(madridNow(new Date('2026-07-01T07:10:00Z'))).toEqual({ day: '2026-07-01', hour: 9 });
    expect(madridNow(new Date('2026-11-21T23:30:00Z'))).toEqual({ day: '2026-11-22', hour: 0 });
  });
});
