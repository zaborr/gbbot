import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import {
  DEFAULT_REFUND_THRESHOLD,
  MAX_TESTING_TIERS,
  tierProgress,
  type Product,
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
  const testings = useAsync(() => api.adminGetTestings(), []);
  const products = useAsync(() => api.adminGetProducts(), []);

  if (testings.loading || products.loading) return <Loader />;
  const error = testings.error ?? products.error;
  if (error) return <ErrorView message={error} />;
  const all = testings.data ?? [];
  const current = isNew ? null : (all.find((x) => x.id === id) ?? null);
  if (!isNew && !current) return <ErrorView message={t('testing.notFound')} />;

  return (
    <TestingForm
      key={current?.id ?? 'new'}
      testing={current}
      testings={all}
      products={products.data ?? []}
    />
  );
}

function TestingForm({
  testing,
  testings,
  products,
}: {
  testing: Testing | null;
  testings: readonly Testing[];
  products: readonly Product[];
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
