import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import {
  DEFAULT_REFUND_THRESHOLD,
  MAX_TESTING_TIERS,
  tierProgress,
  type Product,
  type SettlePreview,
  type Testing,
  type TestingTier,
} from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { Input } from '../../components/Field.js';
import { TestingCard } from '../../components/TestingCard.js';
import { productTitle } from '../../lib/localize.js';
import { formatPrice } from '../../lib/format.js';
import { AdminOnly, ErrorBanner, toMajor, useAdminActions } from './common.js';
import { TestingStatusChip } from './AdminTestingsPage.js';
import { t, tn } from '../../i18n/index.js';

const MONEY_RE = /^\d+([.,]\d{1,2})?$/;
const COUNT_RE = /^\d+$/;
const cents = (text: string): number => Math.round(Number(text.trim().replace(',', '.')) * 100);

/** A tier as typed. */
interface TierDraft {
  id: string;
  name: string;
  cost: string;
  vials: string;
}

const newTier = (): TierDraft => ({
  id: Math.random().toString(36).slice(2, 10),
  name: '',
  cost: '',
  vials: '1',
});

/** `/admin/testings/new` (optionally `?product=…&variant=…`) or `/admin/testings/:id`. */
export function AdminTestingPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminTesting />
    </AdminOnly>
  );
}

function AdminTesting(): React.JSX.Element {
  const { id } = useParams();
  const isNew = id === undefined || id === 'new';
  const [reloadKey, setReloadKey] = useState(0);
  const testings = useAsync(() => api.adminGetTestings(), [reloadKey]);
  const products = useAsync(() => api.adminGetProducts(), []);

  if ((testings.loading && !testings.data) || products.loading) return <Loader />;
  const error = testings.error ?? products.error;
  if (error) return <ErrorView message={error} />;
  const all = testings.data ?? [];
  const current = isNew ? null : (all.find((x) => x.id === id) ?? null);
  if (!isNew && !current) return <ErrorView message={t('testing.notFound')} />;

  return (
    <TestingForm
      key={`${current?.id ?? 'new'}|${current?.status ?? ''}`}
      testing={current}
      testings={all}
      products={products.data ?? []}
      onChange={() => setReloadKey((k) => k + 1)}
    />
  );
}

function TestingForm({
  testing,
  testings,
  products,
  onChange,
}: {
  testing: Testing | null;
  testings: readonly Testing[];
  products: readonly Product[];
  /** Load the testing again (after the draw, a substitution…). */
  onChange: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { shop, to } = useShop();
  const [params] = useSearchParams();
  const actions = useAdminActions(() => undefined);
  const [busy, setBusy] = useState(false);

  // What is tested (chosen only when creating).
  const [productId, setProductId] = useState<string | null>(
    testing?.productId ?? params.get('product'),
  );
  const [variantId, setVariantId] = useState<string | null>(
    testing?.variantId ?? params.get('variant'),
  );
  const product = products.find((p) => p.id === productId) ?? null;
  const withVariants = (product?.variants.length ?? 0) > 0;
  const tested = new Set(testings.map((x) => `${x.productId}|${x.variantId ?? ''}`));
  const isTested = (pid: string, vid: string | null): boolean => tested.has(`${pid}|${vid ?? ''}`);

  const [lab, setLab] = useState(testing?.lab ?? '');
  const [contribution, setContribution] = useState(testing ? toMajor(testing.contribution) : '');
  const [threshold, setThreshold] = useState(
    toMajor(testing?.refundThreshold ?? DEFAULT_REFUND_THRESHOLD),
  );
  const [tiers, setTiers] = useState<TierDraft[]>(
    testing
      ? testing.tiers.map((tier) => ({
          id: tier.id,
          name: tier.name,
          cost: toMajor(tier.cost),
          vials: String(tier.vials),
        }))
      : [newTier()],
  );
  const editable = testing === null || testing.status === 'open';
  // Once people take part, what they signed up for stays: same contribution and
  // tiers (new ones can be added at the end).
  const locked = testing !== null && (testing.participants > 0 || testing.pending > 0);
  const lockedTiers = locked ? (testing?.tiers.length ?? 0) : 0;
  const currency = testing?.currency ?? product?.currency ?? shop.currency;

  const contributionOk = MONEY_RE.test(contribution.trim()) && cents(contribution) > 0;
  const thresholdOk = MONEY_RE.test(threshold.trim());
  const tierOk = (tier: TierDraft): boolean =>
    tier.name.trim() !== '' && MONEY_RE.test(tier.cost.trim()) && cents(tier.cost) > 0 && COUNT_RE.test(tier.vials.trim());
  const parsedTiers: TestingTier[] = tiers.filter(tierOk).map((tier) => ({
    id: tier.id,
    name: tier.name.trim(),
    cost: cents(tier.cost),
    vials: Number(tier.vials.trim()),
  }));

  // How many people each tier needs at this contribution.
  const needs = contributionOk
    ? tierProgress(parsedTiers, 0, cents(contribution)).map((p) =>
        t('testing.needs', {
          tier: p.tier.name,
          people: tn(p.people, 'testing.people.one', 'testing.people.other'),
        }),
      )
    : [];

  const updateTier = (index: number, patch: Partial<TierDraft>): void =>
    setTiers(tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  const moveTier = (index: number, by: -1 | 1): void => {
    const next = [...tiers];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(index + by, 0, moved);
    setTiers(next);
  };

  const problem = !lab.trim()
    ? t('testing.needLab')
    : !contributionOk
      ? t('testing.badContribution')
      : !thresholdOk
        ? t('testing.badThreshold')
        : tiers.length === 0 || parsedTiers.length !== tiers.length
          ? t('testing.badTiers')
          : null;

  const save = async (): Promise<void> => {
    setBusy(true);
    await actions.run(async () => {
      const body = {
        lab: lab.trim(),
        contribution: cents(contribution),
        refundThreshold: cents(threshold),
        tiers: parsedTiers,
      };
      if (testing) {
        await api.adminUpdateTesting(testing.id, body);
      } else {
        if (!productId) throw new Error(t('testing.chooseProduct'));
        await api.adminCreateTesting({ ...body, productId, variantId: withVariants ? variantId : null });
      }
      navigate(to('/admin/testings'), { replace: true });
    });
    setBusy(false);
  };

  // Step 1 when creating: the product, then its variant.
  if (!testing && !product) {
    return (
      <List>
        <PageTitle title={t('testing.new')} />
        <Section header={t('testing.chooseProduct')} footer={t('testing.chooseProductFooter')}>
          {products.length === 0 && <Cell multiline>{t('testing.noProducts')}</Cell>}
          {products.map((p) => {
            const done = p.variants.length === 0 && isTested(p.id, null);
            return (
              <Cell
                key={p.id}
                style={done ? { opacity: 0.5 } : undefined}
                onClick={done ? undefined : () => setProductId(p.id)}
                subtitle={done ? t('testing.alreadyTested') : p.currency}
                after={done ? undefined : '›'}
              >
                {productTitle(p)}
              </Cell>
            );
          })}
        </Section>
      </List>
    );
  }

  const variant = product?.variants.find((v) => v.id === variantId) ?? null;
  const preview: Testing | null =
    parsedTiers.length > 0 && contributionOk
      ? {
          id: testing?.id ?? 'preview',
          productId: productId ?? '',
          variantId: withVariants ? variantId : null,
          productTitle: product ? productTitle(product) : (testing?.productTitle ?? ''),
          variantLabel: variant?.label ?? testing?.variantLabel ?? null,
          currency,
          lab: lab.trim() || '—',
          contribution: cents(contribution),
          refundThreshold: thresholdOk ? cents(threshold) : 0,
          tiers: parsedTiers,
          status: testing?.status ?? 'open',
          raised: testing?.raised ?? 0,
          participants: testing?.participants ?? 0,
          pending: testing?.pending ?? 0,
          joined: false,
          draw: null,
          settlement: null,
          reportSentAt: null,
        }
      : null;

  return (
    <List>
      <PageTitle title={testing ? t('testing.edit') : t('testing.new')} />
      <ErrorBanner message={actions.error} />

      <Section header={t('testing.what')}>
        <Cell
          subtitle={
            testing ? (
              <span className="gb-chips" style={{ marginTop: 4 }}>
                <TestingStatusChip status={testing.status} />
              </span>
            ) : (
              currency
            )
          }
          after={
            testing ? undefined : (
              <Button
                size="s"
                mode="plain"
                onClick={() => {
                  setProductId(null);
                  setVariantId(null);
                }}
              >
                {t('testing.change')}
              </Button>
            )
          }
          multiline
        >
          {product ? productTitle(product) : testing?.productTitle}
        </Cell>
      </Section>

      {!testing && withVariants && product && (
        <Section header={t('testing.chooseVariant')} footer={t('testing.variantFooter')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
            {product.variants.map((v) => (
              <Button
                key={v.id}
                size="s"
                mode={variantId === v.id ? 'filled' : 'bezeled'}
                disabled={isTested(product.id, v.id)}
                onClick={() => setVariantId(v.id)}
              >
                {v.label}
              </Button>
            ))}
          </div>
        </Section>
      )}
      {testing?.variantLabel && (
        <Section header={t('testing.variant')}>
          <Cell>{testing.variantLabel}</Cell>
        </Section>
      )}

      <Section header={t('testing.settings')} footer={t('testing.settingsFooter', { currency })}>
        <Input
          header={t('testing.labField')}
          placeholder={t('testing.labPlaceholder')}
          value={lab}
          disabled={!editable}
          onChange={(e) => setLab(e.target.value)}
        />
        <Input
          header={t('testing.contributionField', { currency })}
          type="text"
          inputMode="decimal"
          placeholder="20.00"
          status={contribution.trim() === '' || contributionOk ? 'default' : 'error'}
          value={contribution}
          disabled={!editable || locked}
          onChange={(e) => setContribution(e.target.value)}
        />
        <Input
          header={t('testing.thresholdField', { currency })}
          type="text"
          inputMode="decimal"
          placeholder="2.00"
          status={thresholdOk ? 'default' : 'error'}
          value={threshold}
          disabled={!editable}
          onChange={(e) => setThreshold(e.target.value)}
        />
      </Section>

      <Section
        header={t('testing.tiers')}
        footer={[locked ? t('testing.lockedFooter') : null, needs.length > 0 ? needs.join(' · ') : t('testing.tiersFooter')]
          .filter(Boolean)
          .join(' ')}
      >
        {tiers.map((tier, index) => {
          const fixed = index < lockedTiers;
          const costBad = tier.cost.trim() !== '' && !(MONEY_RE.test(tier.cost.trim()) && cents(tier.cost) > 0);
          const vialsBad = !COUNT_RE.test(tier.vials.trim());
          return (
            <div key={tier.id} className="gb-testing-tier-edit">
              <Input
                header={t('testing.tierName', { n: index + 1 })}
                placeholder={t('testing.tierNamePlaceholder')}
                value={tier.name}
                disabled={!editable}
                onChange={(e) => updateTier(index, { name: e.target.value })}
              />
              <div className="gb-testing-tier-row">
                <div style={{ flex: 3 }}>
                  <Input
                    header={t('testing.tierCost', { currency })}
                    type="text"
                    inputMode="decimal"
                    placeholder="200.00"
                    status={costBad ? 'error' : 'default'}
                    value={tier.cost}
                    disabled={!editable || fixed}
                    onChange={(e) => updateTier(index, { cost: e.target.value })}
                  />
                </div>
                <div style={{ flex: 2 }}>
                  <Input
                    header={t('testing.tierVials')}
                    type="text"
                    inputMode="numeric"
                    placeholder="1"
                    status={vialsBad ? 'error' : 'default'}
                    value={tier.vials}
                    disabled={!editable || fixed}
                    onChange={(e) => updateTier(index, { vials: e.target.value })}
                  />
                </div>
              </div>
              {editable && !fixed && (
                <div className="gb-testing-tier-actions">
                  <Button
                    size="s"
                    mode="plain"
                    disabled={index <= lockedTiers}
                    onClick={() => moveTier(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    size="s"
                    mode="plain"
                    disabled={index === tiers.length - 1}
                    onClick={() => moveTier(index, 1)}
                  >
                    ↓
                  </Button>
                  <span style={{ flex: 1 }} />
                  <Button
                    size="s"
                    mode="plain"
                    disabled={tiers.length === 1}
                    onClick={() => setTiers(tiers.filter((_, i) => i !== index))}
                  >
                    {t('testing.removeTier')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
        {editable && tiers.length < MAX_TESTING_TIERS && (
          <div style={{ padding: 16 }}>
            <Button stretched mode="bezeled" onClick={() => setTiers([...tiers, newTier()])}>
              {t('testing.addTier')}
            </Button>
          </div>
        )}
      </Section>

      {preview && <TestingCard testing={preview} preview />}

      {testing && <DrawSection testing={testing} onChange={onChange} />}

      {testing && <SettleSection testing={testing} onChange={onChange} />}

      {testing && <ReportSection testing={testing} />}

      {testing && <CancelSection testing={testing} onChange={onChange} />}

      {testing && <Participants testing={testing} />}

      {editable && (
        <Section footer={problem ?? undefined}>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button
              stretched
              loading={busy}
              disabled={problem !== null || (!testing && withVariants && !variantId)}
              onClick={() => void save()}
            >
              {testing ? t('common.save') : t('testing.create')}
            </Button>
            {testing && !locked && (
              <Button
                stretched
                mode="plain"
                onClick={() =>
                  void actions.twoTap('delete', async () => {
                    await api.adminDeleteTesting(testing.id);
                    navigate(to('/admin/testings'), { replace: true });
                  })
                }
              >
                {actions.tapLabel('delete', t('testing.delete'))}
              </Button>
            )}
          </div>
        </Section>
      )}
    </List>
  );
}

/** Who takes part: paid first, then those still to pay; tap one to see the order. */
function Participants({ testing }: { testing: Testing }): React.JSX.Element | null {
  const navigate = useNavigate();
  const { to } = useShop();
  const list = useAsync(() => api.adminGetTestingParticipants(testing.id), [testing.id]);
  if (!list.data) return null;
  const money = (amount: number): string => formatPrice(amount, testing.currency);
  const volunteers = list.data.filter((p) => p.volunteer).length;
  return (
    <Section
      header={t('testing.participants', { count: list.data.length })}
      footer={t('testing.participantsFooter', {
        raised: money(testing.raised),
        pending: money(testing.pending),
        volunteers,
      })}
    >
      {list.data.length === 0 && <Cell multiline>{t('testing.noParticipants')}</Cell>}
      {list.data.map((p) => (
        <Cell
          key={p.orderId}
          onClick={() => navigate(to(`/admin/orders/${p.orderId}`))}
          subtitle={[p.paid ? t('testing.paid') : t('testing.unpaid'), p.volunteer ? t('testing.volunteerChip') : null]
            .filter(Boolean)
            .join(' · ')}
          after={money(p.amount)}
          multiline
        >
          {p.contact ? `${p.name} · @${p.contact}` : p.name}
        </Cell>
      ))}
    </Section>
  );
}

/**
 * The draw of donors: launched by hand once the GB is closed and every
 * contribution paid; the next Bitcoin block decides it.
 */
function DrawSection({ testing, onChange }: { testing: Testing; onChange: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const { to } = useShop();
  const actions = useAdminActions(onChange);
  const status = useAsync(
    () => (testing.status === 'closed' ? api.adminGetDrawStatus(testing.id) : Promise.resolve({ blocker: null })),
    [testing.id, testing.status],
  );
  const draw = testing.draw;
  const blockLink = (hash: string): string => `https://mempool.space/block/${hash}`;
  const vials = testing.tiers.reduce((sum, tier) => sum + tier.vials, 0);

  if (testing.status === 'open' || testing.status === 'cancelled') {
    return (
      <Section header={t('testing.drawTitle')}>
        <Cell multiline>{t('testing.drawWhen', { vials })}</Cell>
      </Section>
    );
  }

  if (testing.status === 'closed') {
    const blocker = status.data?.blocker ?? null;
    const reason =
      blocker === 'gb_open'
        ? t('testing.drawGbOpen')
        : blocker === 'unpaid'
          ? t('testing.drawUnpaid')
          : t('testing.drawReady', { vials });
    return (
      <Section header={t('testing.drawTitle')} footer={t('testing.drawFooter')}>
        <ErrorBanner message={actions.error} />
        <Cell multiline>{reason}</Cell>
        <div style={{ padding: 16 }}>
          <Button
            stretched
            disabled={status.loading || blocker !== null}
            onClick={() => void actions.twoTap('draw', () => api.adminLaunchDraw(testing.id))}
          >
            {actions.tapLabel('draw', t('testing.drawLaunch'))}
          </Button>
        </div>
      </Section>
    );
  }

  // Drawing (waiting for the block) or drawn.
  const byRef = new Map((draw?.candidates ?? []).map((c) => [c.ref, c]));
  return (
    <Section header={t('testing.drawTitle')} footer={t('testing.drawCheck')}>
      <ErrorBanner message={actions.error} />
      {testing.status === 'drawing' && draw && (
        <Cell
          multiline
          after={
            <Button size="s" mode="plain" onClick={onChange}>
              {t('testing.refresh')}
            </Button>
          }
        >
          {t('testing.drawWaiting', { height: draw.height, count: draw.candidates.length })}
        </Cell>
      )}
      {testing.status === 'drawn' && draw?.hash && (
        <>
          <Cell
            multiline
            after={
              <a href={blockLink(draw.hash)} target="_blank" rel="noreferrer">
                {t('testing.drawSeeBlock')}
              </a>
            }
            subtitle={`${draw.hash.slice(0, 16)}…`}
          >
            {t('testing.drawBlock', { height: draw.height })}
          </Cell>
          <Cell multiline>
            {t('testing.drawTiersDone', {
              tiers: testing.tiers.filter((x) => draw.tiersDone.includes(x.id)).map((x) => x.name).join(', ') || '—',
            })}
          </Cell>
          {draw.donors.length === 0 && <Cell multiline>{t('testing.drawNoDonors')}</Cell>}
          {draw.donors.map((ref) => {
            const candidate = byRef.get(ref);
            return (
              <Cell
                key={ref}
                onClick={candidate ? () => navigate(to(`/admin/orders/${candidate.orderId}`)) : undefined}
                subtitle={candidate?.volunteer ? t('testing.volunteerChip') : t('testing.drawnAmongBuyers')}
                after={
                  <Button
                    size="s"
                    mode="plain"
                    onClick={(e) => {
                      e.stopPropagation();
                      void actions.twoTap(`sub-${ref}`, () => api.adminSubstituteDonor(testing.id, ref));
                    }}
                  >
                    {actions.tapLabel(`sub-${ref}`, t('testing.substitute'))}
                  </Button>
                }
                multiline
              >
                {`🎁 #${ref}`}
              </Cell>
            );
          })}
        </>
      )}
      {(draw?.history ?? []).map((h) => (
        <Cell key={`${h.height}-${h.cancelledAt}`} multiline>
          {t('testing.drawCancelledLine', {
            height: h.height,
            donors: h.donors.map((r) => `#${r}`).join(', ') || '—',
          })}
        </Cell>
      ))}
    </Section>
  );
}

/**
 * Settling the money: the real cost of the tests done, maybe an extra tier
 * with the leftover, and what goes back to each participant (shown first).
 */
function SettleSection({ testing, onChange }: { testing: Testing; onChange: () => void }): React.JSX.Element | null {
  const navigate = useNavigate();
  const { to } = useShop();
  const actions = useAdminActions(onChange);
  const money = (amount: number): string => formatPrice(amount, testing.currency);
  const doneIds = testing.status === 'drawn' ? (testing.draw?.tiersDone ?? []) : [];
  const done = testing.tiers.filter((tier) => doneIds.includes(tier.id));
  const [costs, setCosts] = useState<Record<string, string>>(() =>
    Object.fromEntries(done.map((tier) => [tier.id, toMajor(tier.realCost ?? tier.cost)])),
  );
  const [extraName, setExtraName] = useState('');
  const [extraCost, setExtraCost] = useState('');
  const [preview, setPreview] = useState<SettlePreview | null>(null);
  const [busy, setBusy] = useState(false);

  if (testing.status === 'settled' && testing.settlement) {
    const s = testing.settlement;
    return (
      <Section header={t('testing.settleTitle')} footer={t('testing.settledFooter')}>
        <SettlementCells settlement={s} money={money} />
        <Cell onClick={() => navigate(to('/admin/orders?filter=attention'))} after="›" multiline>
          {t('testing.seeRefunds')}
        </Cell>
      </Section>
    );
  }
  if (testing.status !== 'drawn' && testing.status !== 'closed') return null;

  const costsOk = done.every((tier) => MONEY_RE.test((costs[tier.id] ?? '').trim()));
  const extraOk =
    extraName.trim() === '' && extraCost.trim() === ''
      ? true
      : extraName.trim() !== '' && MONEY_RE.test(extraCost.trim()) && cents(extraCost) > 0;
  const body = {
    realCosts: Object.fromEntries(done.map((tier) => [tier.id, cents(costs[tier.id] ?? '0')])),
    ...(extraName.trim() !== '' ? { extra: { name: extraName.trim(), cost: cents(extraCost) } } : {}),
  };
  const calc = (): void => {
    setBusy(true);
    void actions
      .run(async () => setPreview(await api.adminSettlePreview(testing.id, body)))
      .finally(() => setBusy(false));
  };

  return (
    <Section header={t('testing.settleTitle')} footer={t('testing.settleFooter')}>
      <ErrorBanner message={actions.error} />
      {testing.status === 'closed' && <Cell multiline>{t('testing.settleClosed')}</Cell>}
      {done.map((tier) => (
        <Input
          key={tier.id}
          header={t('testing.realCost', { tier: tier.name, currency: testing.currency })}
          type="text"
          inputMode="decimal"
          value={costs[tier.id] ?? ''}
          status={MONEY_RE.test((costs[tier.id] ?? '').trim()) ? 'default' : 'error'}
          onChange={(e) => {
            setCosts({ ...costs, [tier.id]: e.target.value });
            setPreview(null);
          }}
        />
      ))}
      {testing.status === 'drawn' && (
        <div className="gb-testing-tier-row">
          <div style={{ flex: 3 }}>
            <Input
              header={t('testing.extraName')}
              placeholder={t('testing.extraPlaceholder')}
              value={extraName}
              onChange={(e) => {
                setExtraName(e.target.value);
                setPreview(null);
              }}
            />
          </div>
          <div style={{ flex: 2 }}>
            <Input
              header={t('testing.extraCost', { currency: testing.currency })}
              type="text"
              inputMode="decimal"
              value={extraCost}
              status={extraOk ? 'default' : 'error'}
              onChange={(e) => {
                setExtraCost(e.target.value);
                setPreview(null);
              }}
            />
          </div>
        </div>
      )}
      {preview && <SettlementCells settlement={preview.settlement} money={money} />}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!preview ? (
          <Button stretched mode="bezeled" loading={busy} disabled={!costsOk || !extraOk} onClick={calc}>
            {t('testing.settleCalc')}
          </Button>
        ) : (
          <Button
            stretched
            onClick={() => void actions.twoTap('settle', () => api.adminSettleTesting(testing.id, body))}
          >
            {actions.tapLabel('settle', t('testing.settleConfirm'))}
          </Button>
        )}
      </div>
    </Section>
  );
}

/** The money, line by line. */
function SettlementCells({
  settlement,
  money,
}: {
  settlement: SettlePreview['settlement'];
  money: (amount: number) => string;
}): React.JSX.Element {
  return (
    <>
      <Cell after={money(settlement.raised)}>{t('testing.settleRaised')}</Cell>
      {!settlement.allBack && <Cell after={money(settlement.spent)}>{t('testing.settleSpent')}</Cell>}
      {settlement.donorRefunds > 0 && (
        <Cell after={money(settlement.donorRefunds)} multiline>
          {t('testing.settleDonors')}
        </Cell>
      )}
      <Cell multiline after={<strong>{settlement.allBack ? money(settlement.raised) : money(Math.max(settlement.leftover, 0))}</strong>}>
        {settlement.allBack ? t('testing.settleAllBack') : t('testing.settleLeftover')}
      </Cell>
      {!settlement.allBack && (
        <Cell multiline>
          {settlement.leftover < 0
            ? t('testing.settleShort', { amount: money(-settlement.leftover) })
            : settlement.perPerson > 0
              ? t('testing.settlePerPerson', { amount: money(settlement.perPerson) })
              : t('testing.settleBelowThreshold')}
        </Cell>
      )}
    </>
  );
}

/** The lab report: the bot asks the organiser for it and sends it on. */
function ReportSection({ testing }: { testing: Testing }): React.JSX.Element | null {
  const actions = useAdminActions(() => undefined);
  const [asked, setAsked] = useState(false);
  if (testing.status !== 'drawn' && testing.status !== 'settled') return null;
  return (
    <Section header={t('testing.reportTitle')} footer={t('testing.reportFooter')}>
      <ErrorBanner message={actions.error} />
      {testing.reportSentAt && (
        <Cell multiline>
          {t('testing.reportSentOn', { date: new Date(testing.reportSentAt).toLocaleString() })}
        </Cell>
      )}
      {asked && <Cell multiline>{t('testing.reportAsked')}</Cell>}
      <div style={{ padding: 16 }}>
        <Button
          stretched
          mode="bezeled"
          onClick={() =>
            void actions.run(async () => {
              await api.adminRequestTestingReport(testing.id);
              setAsked(true);
            })
          }
        >
          {testing.reportSentAt ? t('testing.reportAgain') : t('testing.reportSend')}
        </Button>
      </div>
    </Section>
  );
}

/** Cancelling: everything paid for it goes back. */
function CancelSection({ testing, onChange }: { testing: Testing; onChange: () => void }): React.JSX.Element | null {
  const actions = useAdminActions(onChange);
  if (testing.status === 'settled' || testing.status === 'cancelled') return null;
  if (testing.participants === 0 && testing.pending === 0) return null;
  return (
    <Section footer={t('testing.cancelFooter')}>
      <ErrorBanner message={actions.error} />
      <div style={{ padding: 16 }}>
        <Button
          stretched
          mode="plain"
          onClick={() => void actions.twoTap('cancel', () => api.adminCancelTesting(testing.id))}
        >
          {actions.tapLabel('cancel', t('testing.cancel'))}
        </Button>
      </div>
    </Section>
  );
}
