import { Cell, Section } from '@telegram-apps/telegram-ui';
import { testingMaxUnits, tierProgress, type Testing } from '@tma-shop/shared';
import { formatPrice } from '../lib/format.js';
import { t, tn } from '../i18n/index.js';

const GREEN = '#31b545';

/**
 * Units bought (by those paying the fee) against the tiers: one bar up to the
 * last tier, a mark at each tier before it, and the units on orders not paid
 * yet in a lighter shade.
 */
export function TestingBar({ testing }: { testing: Testing }): React.JSX.Element {
  const total = Math.max(testingMaxUnits(testing.tiers), 1);
  const percent = (units: number): string => `${Math.min((units / total) * 100, 100)}%`;
  const progress = tierProgress(testing.tiers, testing.units);
  const allReached = progress.every((p) => p.reached);
  const color = allReached ? GREEN : 'var(--tgui--button_color, #2481cc)';
  return (
    <div
      className="gb-testing-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.min(testing.units, total)}
    >
      <div
        className="gb-testing-bar-fill gb-testing-bar-fill--pending"
        style={{ width: percent(testing.units + testing.pendingUnits), background: color }}
      />
      <div className="gb-testing-bar-fill" style={{ width: percent(testing.units), background: color }} />
      {/* A mark at each tier (the last one is the end of the bar). */}
      {progress.slice(0, -1).map((p) => (
        <span key={p.tier.id} className="gb-testing-bar-mark" style={{ left: percent(p.tier.units) }} />
      ))}
    </div>
  );
}

/**
 * The testing of a product (or of one of its variants), as customers see it:
 * the lab, the fee, the bar of units and each tier: reached, next, or later.
 */
export function TestingCard({
  testing,
  preview = false,
  children,
}: {
  testing: Testing;
  /** How it will look (while setting it up). */
  preview?: boolean;
  /** What the customer can do (pay the fee, offer a vial…), at the end. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const money = (amount: number): string => formatPrice(amount, testing.currency);
  const progress = tierProgress(testing.tiers, testing.units);
  const next = progress.find((p) => !p.reached);
  const title = testing.variantLabel
    ? t('testing.cardTitleVariant', { variant: testing.variantLabel })
    : t('testing.cardTitle');
  const units = (n: number): string => tn(n, 'testing.units.one', 'testing.units.other');

  return (
    <Section
      header={title}
      footer={preview ? t('testing.previewFooter') : t('testing.cardRules')}
    >
      <div className="gb-testing-head">
        <div className="gb-chips">
          <span className="gb-chip gb-chip--info">{t('testing.lab', { lab: testing.lab })}</span>
          <span className="gb-chip">
            {testing.exempt
              ? t('testing.feeExemptChip')
              : t(`testing.feeChip.${testing.feeMode}`, { amount: money(testing.contribution) })}
          </span>
          {preview && <span className="gb-chip gb-chip--soft">{t('testing.preview')}</span>}
        </div>
        <TestingBar testing={testing} />
        <span className="gb-hint">
          {next
            ? t('testing.unitsNext', { units: units(testing.units), missing: units(next.missing), tier: next.tier.name })
            : t('testing.unitsAll', { units: units(testing.units) })}
          {testing.pendingUnits > 0 && ` · ${t('testing.pendingUnits', { units: units(testing.pendingUnits) })}`}
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
          after={<span className="gb-testing-tier-cost">{units(p.tier.units)}</span>}
          subtitle={p.reached ? t('testing.tierReached') : t('testing.tierMissingUnits', { units: units(p.missing) })}
          multiline
        >
          {p.tier.name}
        </Cell>
      ))}
      {children}
    </Section>
  );
}
