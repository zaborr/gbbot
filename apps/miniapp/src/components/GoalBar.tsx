import type { GoalProgress } from '@tma-shop/shared';
import { formatPrice } from '../lib/format.js';
import { closingDate } from './ClosingNotice.js';
import { t } from '../i18n/index.js';

const GREEN = '#31b545';

/**
 * Progress towards the GB's minimum: a solid part for what is paid and a light
 * one for what is ordered but not paid yet. Amounts when the GB shows them,
 * otherwise percentages.
 */
export function GoalBar({
  goal,
  closesAt = null,
  compact = false,
}: {
  goal: GoalProgress;
  closesAt?: string | null | undefined;
  compact?: boolean;
}): React.JSX.Element {
  const width = (percent: number): string => `${Math.min(percent, 100)}%`;
  const color = goal.reached ? GREEN : 'var(--tgui--button_color, #2481cc)';
  const money = (amount: number): string => formatPrice(amount, goal.currency);
  const amounts = goal.target !== null && goal.paid !== null && goal.ordered !== null;

  const line = goal.reached
    ? t('goal.reached')
    : amounts
      ? t('goal.amounts', {
          paid: money(goal.paid ?? 0),
          ordered: money(goal.ordered ?? 0),
          target: money(goal.target ?? 0),
        })
      : t('goal.percents', { paid: goal.paidPercent, ordered: goal.orderedPercent });
  const missing =
    !goal.reached && amounts ? money(Math.max((goal.target ?? 0) - (goal.paid ?? 0), 0)) : null;

  return (
    <div style={{ marginTop: compact ? 6 : 10 }}>
      <div
        style={{
          position: 'relative',
          height: compact ? 6 : 10,
          borderRadius: 5,
          overflow: 'hidden',
          background: 'var(--tgui--secondary_fill, rgba(127,127,127,0.18))',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: width(goal.orderedPercent),
            background: color,
            opacity: 0.35,
          }}
        />
        <div
          style={{ position: 'absolute', inset: 0, width: width(goal.paidPercent), background: color }}
        />
      </div>
      <div style={{ fontSize: compact ? 12 : 14, marginTop: 4 }}>
        {goal.reached ? (
          <span style={{ color: GREEN }}>{line}</span>
        ) : (
          <>
            <strong>{goal.paidPercent} %</strong> · {line}
          </>
        )}
      </div>
      {!compact && !goal.reached && (
        <div style={{ fontSize: 13, opacity: 0.7, marginTop: 2 }}>
          {[
            closesAt ? t('goal.deadline', { date: closingDate(closesAt) }) : t('goal.noDeadline'),
            missing ? t('goal.missing', { amount: missing }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}
