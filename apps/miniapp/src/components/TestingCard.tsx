import { Cell, Section } from '@telegram-apps/telegram-ui';
import type { Testing, TestingTierView } from '@tma-shop/shared';
import { formatPrice } from '../lib/format.js';
import { sharePercent, testingState } from '../lib/testingState.js';
import { t, tn } from '../i18n/index.js';

const GREEN = '#31b545';

/**
 * How far the testing is: one stretch of the bar per tier (no money shown), the
 * ones reached full and the next one as far as it is covered.
 */
export function TestingBar({ testing }: { testing: Testing }): React.JSX.Element {
  const count = Math.max(testing.tiers.length, 1);
  const done = testing.tiers.reduce((sum, tier) => sum + (tier.reached ? 1 : 0), 0);
  const next = testing.tiers.find((tier) => !tier.reached);
  const filled = Math.min((done + (next?.share ?? 0)) / count, 1);
  const color = done === testing.tiers.length ? GREEN : 'var(--tgui--button_color, #2481cc)';
  return (
    <div
      className="gb-testing-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(filled * 100)}
    >
      <div className="gb-testing-bar-fill" style={{ width: `${filled * 100}%`, background: color }} />
      {/* A mark where each tier ends (the last one is the end of the bar). */}
      {testing.tiers.slice(0, -1).map((tier, i) => (
        <span key={tier.id} className="gb-testing-bar-mark" style={{ left: `${((i + 1) / count) * 100}%` }} />
      ))}
    </div>
  );
}

/** "About 17 units missing", or how much is covered when units cannot be told. */
function missingText(tier: TestingTierView): string {
  return tier.unitsLeft !== null
    ? t('testing.unitsLeft', { units: tn(tier.unitsLeft, 'testing.units.one', 'testing.units.other') })
    : t('testing.shareCovered', { percent: sharePercent(tier) });
}

/**
 * The testing of a product (or of one of its variants), as customers see it:
 * the lab, the fee, the bar and each tier: reached, next, or later.
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
  const { next } = testingState(testing);
  const title = testing.variantLabel
    ? t('testing.cardTitleVariant', { variant: testing.variantLabel })
    : t('testing.cardTitle');

  return (
    <Section header={title} footer={preview ? t('testing.previewFooter') : t('testing.cardRules')}>
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
          {next ? t('testing.nextTier', { missing: missingText(next), tier: next.name }) : t('testing.allTiers')}
        </span>
        {testing.donationsOpen && testing.donationsUntil && (
          <span className="gb-hint">
            {t('testing.cardDonations', { date: new Date(testing.donationsUntil).toLocaleString() })}
          </span>
        )}
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
      {testing.tiers.map((tier) => (
        <Cell
          key={tier.id}
          before={
            <span className="gb-testing-tier-icon" aria-hidden="true">
              {tier.upgradedTo ? '⬆️' : tier.reached ? '✅' : tier === next ? '⏳' : '🔒'}
            </span>
          }
          subtitle={[
            tier.upgradedTo
              ? t('testing.tierUpgradedTo', { tier: tier.upgradedTo })
              : tier.reached
                ? t('testing.tierReached')
                : missingText(tier),
            tier.upgrades ? t('testing.tierUpgradeOf', { tier: tier.upgrades }) : null,
            tier.lab ? t('testing.lab', { lab: tier.lab }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          multiline
        >
          {tier.name}
        </Cell>
      ))}
      {children}
    </Section>
  );
}
