import { Cell, Section } from '@telegram-apps/telegram-ui';
import { testingTarget, tierProgress, type Testing } from '@tma-shop/shared';
import { formatPrice } from '../lib/format.js';
import { t, tn } from '../i18n/index.js';

const GREEN = '#31b545';

/**
 * Money raised against the tiers: one bar for the whole testing, with a mark
 * where each tier is reached (its cumulative cost).
 */
export function TestingBar({ testing }: { testing: Testing }): React.JSX.Element {
  const total = Math.max(testingTarget(testing.tiers, testing.contribution), 1);
  const percent = (amount: number): string => `${Math.min((amount / total) * 100, 100)}%`;
  const progress = tierProgress(testing.tiers, testing.raised, testing.contribution);
  const allReached = progress.every((p) => p.reached);
  const color = allReached ? GREEN : 'var(--tgui--button_color, #2481cc)';
  return (
    <div
      className="gb-testing-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.min(testing.raised, total)}
    >
      <div
        className="gb-testing-bar-fill gb-testing-bar-fill--pending"
        style={{ width: percent(testing.raised + testing.pending), background: color }}
      />
      <div className="gb-testing-bar-fill" style={{ width: percent(testing.raised), background: color }} />
      {/* A mark between tiers (the last one is the end of the bar). */}
      {progress.slice(0, -1).map((p) => (
        <span key={p.tier.id} className="gb-testing-bar-mark" style={{ left: percent(p.threshold) }} />
      ))}
    </div>
  );
}

/**
 * The testing of a product (or of one of its variants), as customers see it:
 * the lab, the contribution, the bar and each tier with what it still needs.
 */
export function TestingCard({
  testing,
  preview = false,
  children,
}: {
  testing: Testing;
  /** How it will look (while setting it up). */
  preview?: boolean;
  /** What the customer can do (join, offer a vial…), at the end. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const money = (amount: number): string => formatPrice(amount, testing.currency);
  const progress = tierProgress(testing.tiers, testing.raised, testing.contribution);
  const next = progress.find((p) => !p.reached);
  const title = testing.variantLabel
    ? t('testing.cardTitleVariant', { variant: testing.variantLabel })
    : t('testing.cardTitle');

  return (
    <Section
      header={title}
      footer={preview ? t('testing.previewFooter') : t('testing.cardFooter')}
    >
      <div className="gb-testing-head">
        <div className="gb-chips">
          <span className="gb-chip gb-chip--info">{t('testing.lab', { lab: testing.lab })}</span>
          <span className="gb-chip">{t('testing.contribution', { amount: money(testing.contribution) })}</span>
          {preview && <span className="gb-chip gb-chip--soft">{t('testing.preview')}</span>}
        </div>
        <TestingBar testing={testing} />
        <span className="gb-hint">
          {next
            ? t('testing.raisedNext', {
                raised: money(testing.raised),
                target: money(next.threshold),
                tier: next.tier.name,
              })
            : t('testing.allReached', { raised: money(testing.raised) })}
          {testing.pending > 0 && ` · ${t('testing.pendingAmount', { amount: money(testing.pending) })}`}
        </span>
        {testing.status === 'settled' && <span className="gb-hint">{t('testing.cardSettled')}</span>}
        {testing.status === 'cancelled' && <span className="gb-hint">{t('testing.cardCancelled')}</span>}
        {testing.reportSentAt && (
          <span className="gb-hint">
            {t('testing.cardReport', { date: new Date(testing.reportSentAt).toLocaleDateString() })}
          </span>
        )}
        {testing.status === 'drawing' && testing.draw && (
          <span className="gb-hint">{t('testing.cardDrawing', { height: testing.draw.height })}</span>
        )}
        {testing.status === 'drawn' && testing.draw?.hash && (
          <span className="gb-hint">
            {t('testing.cardDrawn', {
              height: testing.draw.height,
              donors: testing.draw.donors.map((r) => `#${r}`).join(', ') || '—',
            })}{' '}
            <a href={`https://mempool.space/block/${testing.draw.hash}`} target="_blank" rel="noreferrer">
              {t('testing.drawSeeBlock')}
            </a>
          </span>
        )}
      </div>
      {progress.map((p) => (
        <Cell
          key={p.tier.id}
          before={
            <span className="gb-testing-tier-icon" aria-hidden="true">
              {p.reached ? '✅' : p === next ? '⏳' : '🔒'}
            </span>
          }
          after={<span className="gb-testing-tier-cost">{money(p.tier.cost)}</span>}
          subtitle={
            p.reached
              ? t('testing.tierReached')
              : t('testing.tierMissing', {
                  amount: money(p.missing),
                  people: tn(p.people, 'testing.people.one', 'testing.people.other'),
                })
          }
          multiline
        >
          {p.tier.name}
        </Cell>
      ))}
      {children}
    </Section>
  );
}
