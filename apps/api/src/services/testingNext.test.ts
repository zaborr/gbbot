import { describe, expect, it } from 'vitest';
import type { testings } from '../db/schema.js';
import { nextOf } from './testingNext.js';

type Row = typeof testings.$inferSelect;
const NOW = new Date('2026-11-21T12:00:00Z');
const row = (patch: Partial<Row>): Row =>
  ({
    status: 'closed',
    extra: null,
    donationsDone: true,
    donationsUntil: null,
    labProgress: null,
    report: null,
    extraReport: null,
    ...patch,
  }) as Row;
const reached = { tiers: [{ reached: true }] } as never;
const none = { tiers: [{ reached: false }] } as never;
const closedShop = { closedAt: new Date('2026-11-20T00:00:00Z'), closesAt: null };

describe('what comes next in a testing', () => {
  it('waits while the GB is open, the time to give or the extra round lasts', () => {
    const open = nextOf(row({ status: 'open' }), reached, { closedAt: null, closesAt: NOW }, 2, null, NOW);
    expect(open).toMatchObject({ phase: 'open', step: 'wait_gb', action: false, until: NOW.toISOString(), unpaid: 2 });
    const until = new Date('2026-11-22T00:00:00Z');
    expect(nextOf(row({ donationsDone: false, donationsUntil: until }), reached, closedShop, 0, null, NOW)).toMatchObject({
      phase: 'window',
      step: 'wait_window',
      action: false,
    });
    const extra = { stage: 'pay', until: until.toISOString(), target: [], share: 0 } as Row['extra'];
    expect(nextOf(row({ extra }), reached, closedShop, 0, null, NOW)).toMatchObject({ phase: 'extra', step: 'wait_extra' });
  });

  it('asks the organisers to act: unpaid, the draw, or closing one with nothing reached', () => {
    expect(nextOf(row({}), reached, closedShop, 3, 'unpaid', NOW)).toMatchObject({ step: 'unpaid', action: true, unpaid: 3 });
    expect(nextOf(row({}), reached, closedShop, 0, null, NOW)).toMatchObject({ step: 'draw', action: true });
    expect(nextOf(row({}), none, closedShop, 0, null, NOW)).toMatchObject({ step: 'settle', action: true });
  });

  it('follows the lab after the draw, until it can be closed', () => {
    const drawn = (patch: Partial<Row>) => nextOf(row({ status: 'drawn', ...patch }), reached, closedShop, 0, null, NOW);
    expect(drawn({})).toMatchObject({ phase: 'lab', step: 'vials', action: true });
    expect(drawn({ labProgress: { sentAt: 'x' } })).toMatchObject({ step: 'wait_lab', action: false });
    expect(drawn({ labProgress: { sentAt: 'x', receivedAt: 'y', expected: '2026-12-01' } })).toMatchObject({
      step: 'wait_report',
      action: false,
      until: '2026-12-01',
    });
    expect(drawn({ labProgress: { sentAt: 'x', receivedAt: 'y', expected: '2026-11-10' } })).toMatchObject({
      step: 'report',
      action: true,
    });
    const report = { fileId: 'f', kind: 'document' as const, sentAt: 'z' };
    expect(drawn({ labProgress: { sentAt: 'x', receivedAt: 'y' }, report })).toMatchObject({ step: 'settle', action: true });
    // The extra round's tests have their own report.
    const extra = { stage: 'done', until: '', target: ['a'], share: 1, outcome: { tiers: ['a'], collected: 1, refunded: 0 } } as Row['extra'];
    expect(drawn({ labProgress: { sentAt: 'x', receivedAt: 'y' }, report, extra })).toMatchObject({ step: 'wait_report' });
  });

  it('says nothing more once settled or cancelled', () => {
    expect(nextOf(row({ status: 'settled' }), reached, closedShop, 0, null, NOW)).toMatchObject({ phase: 'done', step: null });
    expect(nextOf(row({ status: 'cancelled' }), reached, closedShop, 0, null, NOW)).toMatchObject({ phase: 'cancelled', step: null });
  });
});
