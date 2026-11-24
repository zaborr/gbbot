import type { Testing, TestingNext } from '@tma-shop/shared';
import { formatDateTime, formatPrice } from '../lib/format.js';
import { locale, t, tn } from '../i18n/index.js';

/** What comes next in a testing, in words ("Ready to launch the draw"). */
export function nextText(next: TestingNext): string | null {
  const date = next.until ? (next.until.length === 10 ? new Date(`${next.until}T12:00:00`).toLocaleDateString(locale()) : formatDateTime(next.until)) : null;
  switch (next.step) {
    case null:
      return null;
    case 'wait_gb':
      return date ? t('testing.next.waitGbUntil', { date }) : t('testing.next.waitGb');
    case 'wait_window':
      return t('testing.next.waitWindow', { date: date ?? '—' });
    case 'wait_extra':
      return t('testing.next.waitExtra', { date: date ?? '—' });
    case 'unpaid':
      return tn(next.unpaid, 'testing.next.unpaid.one', 'testing.next.unpaid.other');
    case 'extra':
      return t('testing.next.extra');
    case 'draw':
      return t('testing.next.draw');
    case 'wait_block':
      return t('testing.next.waitBlock');
    case 'vials':
      return t('testing.next.vials');
    case 'wait_lab':
      return t('testing.next.waitLab');
    case 'wait_report':
      return date ? t('testing.next.waitReportOn', { date }) : t('testing.next.waitReport');
    case 'report':
      return t('testing.next.report', { date: date ?? '—' });
    case 'settle':
      return t('testing.next.settle');
  }
}

/** The next step as a line: marked when it is the organisers' turn. */
export function TestingNextLine({ next }: { next: TestingNext }): React.JSX.Element | null {
  const text = nextText(next);
  if (!text) return null;
  return (
    <span style={{ fontWeight: next.action ? 600 : 400, color: next.action ? 'var(--tgui--link_color)' : undefined }}>
      {next.action ? `👉 ${text}` : text}
    </span>
  );
}

/** "Pot 120 · next tier (M&P): 30 missing", or every tier reached. */
export function potLine(testing: Testing): string | null {
  const money = testing.money;
  if (!money) return null;
  const fmt = (amount: number): string => formatPrice(amount, testing.currency);
  const index = money.steps.findIndex((step) => step.missing > 0);
  const step = index >= 0 ? money.steps[index] : undefined;
  const tier = index >= 0 ? testing.tiers[index] : undefined;
  if (!step || !tier) return t('testing.panel.allReached', { pot: fmt(money.pot) });
  return t('testing.panel.pot', { pot: fmt(money.pot), tier: tier.name, missing: fmt(step.missing) });
}
