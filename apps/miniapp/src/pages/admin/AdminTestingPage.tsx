import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Cell, List, Section, Switch } from '@telegram-apps/telegram-ui';
import {
  MAX_DONATION_HOURS,
  MAX_TESTING_TIERS,
  tierSteps,
  type Product,
  type Testing,
  type TestingFeeMode,
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
import { formatPrice, formatDateTime } from '../../lib/format.js';
import { AdminOnly, ErrorBanner, toMajor, useAdminActions } from './common.js';
import { TestingStatusChip } from './AdminTestingsPage.js';
import { t, tn } from '../../i18n/index.js';

const MONEY_RE = /^\d+([.,]\d{1,2})?$/;
const COUNT_RE = /^\d+$/;
const cents = (text: string): number => Math.round(Number(text.trim().replace(',', '.')) * 100);
const units = (n: number): string => tn(n, 'testing.units.one', 'testing.units.other');

/** A tier as typed. */
interface TierDraft {
  id: string;
  name: string;
  cost: string;
  vials: string;
  /** Empty: the testing's lab. */
  lab: string;
  /** The earlier tier it upgrades, or null. */
  replaces: string | null;
}

const newTier = (): TierDraft => ({
  id: Math.random().toString(36).slice(2, 10),
  name: '',
  cost: '',
  vials: '1',
  lab: '',
  replaces: null,
});

const FEE_MODES: TestingFeeMode[] = ['mandatory', 'mandatory_non_vip', 'optional'];

/** Hours typed for a stage: whole, from 1 to the most allowed. */
const hoursField = (text: string): boolean =>
  /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= MAX_DONATION_HOURS;

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
  // One at a time: a product can have another once its last is settled or cancelled.
  const tested = new Set(
    testings
      .filter((x) => x.status !== 'settled' && x.status !== 'cancelled')
      .map((x) => `${x.productId}|${x.variantId ?? ''}`),
  );
  const isTested = (pid: string, vid: string | null): boolean => tested.has(`${pid}|${vid ?? ''}`);

  const money = testing?.money ?? null;
  const [lab, setLab] = useState(testing?.lab ?? '');
  const [contribution, setContribution] = useState(testing ? toMajor(testing.contribution) : '');
  // A testing after closing: the GB is already paid, so nothing per unit unless set.
  const [perUnit, setPerUnit] = useState(money ? toMajor(money.perUnit) : shop.isClosed ? '0' : '');
  const [feeMode, setFeeMode] = useState<TestingFeeMode>(testing?.feeMode ?? 'mandatory');
  const [donationHours, setDonationHours] = useState(String(testing?.donationHours ?? 48));
  const [vialsPerUnit, setVialsPerUnit] = useState(String(testing?.vialsPerUnit ?? 10));
  const [extraEnabled, setExtraEnabled] = useState(testing?.extraEnabled ?? false);
  const [allowExternal, setAllowExternal] = useState(testing?.allowExternal ?? false);
  const [extraMinText, setExtraMinText] = useState(testing && testing.extraMin > 0 ? toMajor(testing.extraMin) : '');
  const [signupHours, setSignupHours] = useState(String(testing?.extraSignupHours ?? 24));
  const [payHours, setPayHours] = useState(String(testing?.extraPayHours ?? 48));
  const [tiers, setTiers] = useState<TierDraft[]>(
    money
      ? money.tiers.map((tier) => ({
          id: tier.id,
          name: tier.name,
          cost: toMajor(tier.cost),
          vials: String(tier.vials),
          lab: tier.lab ?? '',
          replaces: tier.replaces ?? null,
        }))
      : [newTier()],
  );
  // The tiers and the hidden part are the organiser's own sums: they change
  // until the draw. The fee stays once someone took part.
  const editable = testing === null || testing.status === 'open' || testing.status === 'closed';
  const locked = (money?.entries ?? 0) > 0;
  const currency = testing?.currency ?? product?.currency ?? shop.currency;
  const fmt = (amount: number): string => formatPrice(amount, currency);

  // 0: everyone takes part for free (the money comes from gifts and the extra round).
  const contributionOk = MONEY_RE.test(contribution.trim()) && cents(contribution) >= 0;
  const extraMinCents = extraMinText.trim() === '' || !MONEY_RE.test(extraMinText.trim()) ? 0 : cents(extraMinText);
  const perUnitOk = perUnit.trim() === '' || MONEY_RE.test(perUnit.trim());
  const perUnitCents = perUnit.trim() === '' || !perUnitOk ? 0 : cents(perUnit);
  const tierOk = (tier: TierDraft): boolean =>
    tier.name.trim() !== '' && MONEY_RE.test(tier.cost.trim()) && cents(tier.cost) > 0 && COUNT_RE.test(tier.vials.trim());
  // An upgrade only of a tier before it (moving tiers around can undo that).
  const upgradeOk = (index: number): boolean => {
    const target = tiers[index]?.replaces;
    return !target || tiers.slice(0, index).some((tier) => tier.id === target);
  };
  const parsedTiers: TestingTier[] = tiers.filter(tierOk).map((tier) => ({
    id: tier.id,
    name: tier.name.trim(),
    cost: cents(tier.cost),
    vials: Number(tier.vials.trim()),
    lab: tier.lab.trim() && tier.lab.trim() !== lab.trim() ? tier.lab.trim() : null,
    replaces: upgradeOk(tiers.indexOf(tier)) ? tier.replaces : null,
  }));

  // The price of a vial (what a donor gets back), and what a unit adds.
  const variant = product?.variants.find((v) => v.id === variantId) ?? null;
  const vialsOk = COUNT_RE.test(vialsPerUnit.trim()) && Number(vialsPerUnit) >= 1 && Number(vialsPerUnit) <= 100;
  const vialsNumber = vialsOk ? Number(vialsPerUnit) : 1;
  // One vial's share of the unit's price (what its donor gets back).
  const unitPrice = variant?.price ?? product?.price ?? null;
  const vialPrice =
    unitPrice !== null
      ? Math.round(unitPrice / vialsNumber)
      : money && testing?.vialsPerUnit === vialsNumber
        ? money.vialPrice
        : Math.round(((money?.vialPrice ?? 0) * (testing?.vialsPerUnit ?? 1)) / vialsNumber);
  const pot = money?.pot ?? 0;
  const draftUnitValue = perUnitCents > 0 ? perUnitCents : contributionOk ? cents(contribution) : 0;
  const unitValue = money && money.perUnit === perUnitCents ? money.unitValue : draftUnitValue;
  const steps = tierSteps({ tiers: parsedTiers, pot, vialPrice, unitValue });
  // From zero: how many units each tier means (with the tiers before it).
  const fromZero = tierSteps({ tiers: parsedTiers, pot: 0, vialPrice, unitValue: draftUnitValue });

  const updateTier = (index: number, patch: Partial<TierDraft>): void =>
    setTiers(tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  const moveTier = (index: number, by: -1 | 1): void => {
    const next = [...tiers];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(index + by, 0, moved);
    setTiers(next);
  };

  // Made once the GB is closed: people join with their part from their orders, for some hours.
  const posterior = testing ? testing.posterior : shop.isClosed;
  const hoursOk =
    COUNT_RE.test(donationHours.trim()) &&
    Number(donationHours) <= MAX_DONATION_HOURS &&
    (!posterior || Number(donationHours) >= 1);
  const modes = posterior ? FEE_MODES.filter((mode) => mode !== 'optional') : FEE_MODES;
  const problem = !lab.trim()
    ? t('testing.needLab')
    : !contributionOk
      ? t('testing.badContribution')
      : !perUnitOk
        ? t('testing.badPerUnit')
        : tiers.length === 0 || parsedTiers.length !== tiers.length
          ? t('testing.badTiers')
          : !hoursOk
            ? t('testing.badDonationHours', { max: MAX_DONATION_HOURS })
            : !vialsOk
              ? t('testing.badVialsPerUnit')
              : extraEnabled && (!hoursField(signupHours) || !hoursField(payHours))
                ? t('testing.badExtraHours', { max: MAX_DONATION_HOURS })
                : extraEnabled && cents(contribution) === 0 && extraMinCents === 0
                  ? t('testing.needExtraMin')
                  : null;

  const save = async (): Promise<void> => {
    setBusy(true);
    await actions.run(async () => {
      const body = {
        lab: lab.trim(),
        contribution: cents(contribution),
        perUnit: perUnitCents,
        feeMode,
        tiers: parsedTiers,
        donationHours: Number(donationHours),
        vialsPerUnit: vialsNumber,
        extraEnabled,
        extraMin: extraMinCents,
        extraSignupHours: Number(signupHours) || 24,
        extraPayHours: Number(payHours) || 48,
        allowExternal,
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

  // How customers will see it (no money): the tiers against the pot as it is now.
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
          feeMode,
          tiers: steps.map((step) => ({
            id: step.tier.id,
            name: step.tier.name,
            vials: step.tier.vials,
            lab: step.tier.lab ?? null,
            upgrades: step.tier.replaces
              ? (parsedTiers.find((x) => x.id === step.tier.replaces)?.name ?? null)
              : null,
            upgradedTo: step.upgradedTo?.name ?? null,
            reached: step.reached,
            share: step.share,
            unitsLeft: step.unitsLeft,
          })),
          status: testing?.status ?? 'open',
          participants: testing?.participants ?? 0,
          joined: false,
          volunteer: false,
          exempt: false,
          // Editing: where it really is (its time, extra round, draw).
          draw: testing?.draw ?? null,
          reportSentAt: testing?.reportSentAt ?? null,
          donationHours: Number(donationHours) || 48,
          vialsPerUnit: vialsNumber,
          extraEnabled,
          extraMin: 0,
          extraSignupHours: 24,
          extraPayHours: 48,
          extra: testing?.extra ?? null,
          extraReportSentAt: testing?.extraReportSentAt ?? null,
          posterior,
          allowExternal,
          externalOpen: testing?.externalOpen ?? false,
          donationsUntil: testing?.donationsUntil ?? null,
          donationsOpen: testing?.donationsOpen ?? false,
          donationProductId: null,
          money: null,
        }
      : null;

  return (
    <List>
      <PageTitle title={testing ? t('testing.edit') : t('testing.new')} />
      {posterior && (
        <Section>
          <Cell multiline subtitle={t('testing.posteriorHint')}>
            {t('testing.posteriorTitle')}
          </Cell>
        </Section>
      )}
      <ErrorBanner message={actions.error} />

      <Section header={t('testing.what')}>
        <Cell
          subtitle={
            testing ? (
              <span className="gb-chips" style={{ marginTop: 4 }}>
                <TestingStatusChip testing={testing} />
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

      {money && testing && <PotSection testing={testing} steps={steps} />}

      <Section header={t('testing.settings')} footer={t('testing.settingsFooter', { currency })}>
        <Input
          header={t('testing.labField')}
          placeholder={t('testing.labPlaceholder')}
          value={lab}
          disabled={!editable}
          onChange={(e) => setLab(e.target.value)}
        />
        <Input
          header={posterior ? t('testing.partField', { currency }) : t('testing.contributionField', { currency })}
          type="text"
          inputMode="decimal"
          placeholder="5.00"
          status={contribution.trim() === '' || contributionOk ? 'default' : 'error'}
          value={contribution}
          disabled={!editable || locked}
          onChange={(e) => setContribution(e.target.value)}
        />
        <Input
          header={t('testing.perUnitField', { currency })}
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          status={perUnitOk ? 'default' : 'error'}
          value={perUnit}
          disabled={!editable}
          onChange={(e) => setPerUnit(e.target.value)}
        />
        <Cell multiline>
          <span className="gb-hint">
            {locked ? t('testing.feeLockedHint') : posterior ? t('testing.perUnitPosteriorHint') : t('testing.perUnitHint')}
          </span>
        </Cell>
        <Input
          header={t('testing.vialsPerUnitField')}
          type="text"
          inputMode="numeric"
          placeholder="10"
          status={vialsOk ? 'default' : 'error'}
          value={vialsPerUnit}
          disabled={!editable}
          onChange={(e) => setVialsPerUnit(e.target.value)}
        />
        <Cell multiline>
          <span className="gb-hint">
            {t('testing.vialsPerUnitHint', { amount: fmt(vialPrice) })}
          </span>
        </Cell>
        <Input
          header={posterior ? t('testing.posteriorHoursField') : t('testing.donationHoursField')}
          type="text"
          inputMode="numeric"
          placeholder="48"
          status={hoursOk ? 'default' : 'error'}
          value={donationHours}
          disabled={!editable}
          onChange={(e) => setDonationHours(e.target.value)}
        />
        <Cell multiline>
          <span className="gb-hint">
            {posterior ? t('testing.posteriorHoursHint') : t('testing.donationHoursHint')}
          </span>
        </Cell>
      </Section>

      <Section
        header={t('testing.feeMode')}
        footer={posterior ? t(`testing.posteriorMode.${feeMode === 'mandatory_non_vip' ? 'vip' : 'all'}.hint`) : t(`testing.feeMode.${feeMode}.hint`)}
      >
        <div className="gb-chips" style={{ padding: '12px 16px' }}>
          {modes.map((mode) => (
            <Button
              key={mode}
              size="s"
              mode={feeMode === mode ? 'filled' : 'bezeled'}
              disabled={!editable || locked}
              onClick={() => setFeeMode(mode)}
            >
              {posterior ? t(`testing.posteriorMode.${mode === 'mandatory_non_vip' ? 'vip' : 'all'}`) : t(`testing.feeMode.${mode}`)}
            </Button>
          ))}
        </div>
      </Section>

      <Section
        header={t('testing.tiers')}
        footer={[
          t('testing.tiersMoneyFooter'),
          vialPrice > 0 ? t('testing.vialPriceHint', { amount: fmt(vialPrice) }) : null,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {tiers.map((tier, index) => {
          const costBad = tier.cost.trim() !== '' && !(MONEY_RE.test(tier.cost.trim()) && cents(tier.cost) > 0);
          const vialsBad = !COUNT_RE.test(tier.vials.trim());
          const zero = fromZero.find((step) => step.tier.id === tier.id);
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
                    disabled={!editable}
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
                    disabled={!editable}
                    onChange={(e) => updateTier(index, { vials: e.target.value })}
                  />
                </div>
              </div>
              <Input
                header={t('testing.tierLab')}
                placeholder={lab.trim() || t('testing.labPlaceholder')}
                value={tier.lab}
                disabled={!editable}
                onChange={(e) => updateTier(index, { lab: e.target.value })}
              />
              {index > 0 && (
                <div className="gb-testing-tier-upgrade">
                  <span className="gb-hint">{t('testing.tierUpgrades')}</span>
                  <div className="gb-chips">
                    <Button
                      size="s"
                      mode={tier.replaces === null ? 'filled' : 'bezeled'}
                      disabled={!editable}
                      onClick={() => updateTier(index, { replaces: null })}
                    >
                      {t('testing.tierUpgradesNone')}
                    </Button>
                    {tiers.slice(0, index).map((before) => {
                      const taken = tiers.some((x) => x.id !== tier.id && x.replaces === before.id);
                      return (
                        <Button
                          key={before.id}
                          size="s"
                          mode={tier.replaces === before.id ? 'filled' : 'bezeled'}
                          disabled={!editable || taken}
                          onClick={() => updateTier(index, { replaces: before.id })}
                        >
                          {before.name.trim() || t('testing.tierName', { n: tiers.indexOf(before) + 1 })}
                        </Button>
                      );
                    })}
                  </div>
                  {tier.replaces && !upgradeOk(index) && (
                    <span className="gb-hint">{t('testing.tierUpgradeMoved')}</span>
                  )}
                </div>
              )}
              {zero && zero.unitsLeft !== null && (
                <span className="gb-hint gb-testing-tier-hint">
                  {t('testing.tierEquals', { amount: fmt(zero.needed), units: units(zero.unitsLeft) })}
                </span>
              )}
              {editable && (
                <div className="gb-testing-tier-actions">
                  <Button size="s" mode="plain" disabled={index === 0} onClick={() => moveTier(index, -1)}>
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
                    onClick={() =>
              setTiers(
                tiers
                  .filter((_, i) => i !== index)
                  .map((x) => (x.replaces === tier.id ? { ...x, replaces: null } : x)),
              )
            }
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

      <Section header={t('testing.extraTitle')} footer={t('testing.extraFooter')}>
        <Cell
          Component="label"
          multiline
          after={
            <Switch
              checked={extraEnabled}
              disabled={!editable || Boolean(testing?.extra)}
              onChange={(e) => setExtraEnabled(e.target.checked)}
            />
          }
        >
          {t('testing.extraEnable')}
        </Cell>
        {extraEnabled && (
          <Input
            header={t('testing.extraMinField', { currency })}
            type="text"
            inputMode="decimal"
            placeholder={contributionOk ? toMajor(cents(contribution)) : '5.00'}
            status={extraMinText.trim() === '' || MONEY_RE.test(extraMinText.trim()) ? 'default' : 'error'}
            value={extraMinText}
            disabled={!editable || Boolean(testing?.extra)}
            onChange={(e) => setExtraMinText(e.target.value)}
          />
        )}
        {extraEnabled && (
          <div className="gb-testing-tier-row">
            <div style={{ flex: 1 }}>
              <Input
                header={t('testing.extraSignupHours')}
                type="text"
                inputMode="numeric"
                placeholder="24"
                status={hoursField(signupHours) ? 'default' : 'error'}
                value={signupHours}
                disabled={!editable || Boolean(testing?.extra)}
                onChange={(e) => setSignupHours(e.target.value)}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Input
                header={t('testing.extraPayHours')}
                type="text"
                inputMode="numeric"
                placeholder="48"
                status={hoursField(payHours) ? 'default' : 'error'}
                value={payHours}
                disabled={!editable || Boolean(testing?.extra)}
                onChange={(e) => setPayHours(e.target.value)}
              />
            </div>
          </div>
        )}
      </Section>

      <Section header={t('testing.externalAdminTitle')} footer={t('testing.externalAdminFooter')}>
        <Cell
          Component="label"
          multiline
          after={
            <Switch
              checked={allowExternal}
              disabled={!editable}
              onChange={(e) => setAllowExternal(e.target.checked)}
            />
          }
        >
          {t('testing.externalEnable')}
        </Cell>
      </Section>

      {testing?.extra && <ExtraStatus testing={testing} />}

      {parsedTiers.length > 0 && contributionOk && (
        <Simulator
          tiers={parsedTiers}
          fee={cents(contribution)}
          perUnit={perUnitCents}
          vialPrice={vialPrice}
          currency={currency}
        />
      )}

      {preview && <TestingCard testing={preview} preview />}

      {testing && <DrawSection testing={testing} onChange={onChange} />}

      {testing && <ReopenSection testing={testing} onChange={onChange} />}
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

/** One "label … amount" line of the pot. */
function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }): React.JSX.Element {
  return (
    <Cell after={<span className={strong ? 'gb-testing-money gb-testing-money--strong' : 'gb-testing-money'}>{value}</span>}>
      {strong ? <strong>{label}</strong> : label}
    </Cell>
  );
}

/**
 * The organiser's view of the money: where the pot comes from, each tier in
 * money and in units, and what is left once the tiers reached are paid.
 */
function PotSection({ testing, steps }: { testing: Testing; steps: ReturnType<typeof tierSteps> }): React.JSX.Element | null {
  const m = testing.money;
  if (!m) return null;
  const fmt = (amount: number): string => formatPrice(amount, testing.currency);
  const next = steps.find((step) => !step.reached);
  return (
    <>
      <Section
        header={t('testing.potTitle')}
        footer={[
          t('testing.potFooter'),
          m.pendingUnits > 0 ? t('testing.potPending', { units: units(m.pendingUnits) }) : null,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <Line
          label={t('testing.potFees', { count: m.payers, amount: fmt(testing.contribution) })}
          value={fmt(m.fees)}
        />
        {/* What was given on top of the part, in the cart or from the order: all one. */}
        <Line label={t('testing.potDonations')} value={fmt(m.extras + m.donations)} />
        <Line
          label={t('testing.potHidden', { units: units(m.units), amount: fmt(m.perUnit) })}
          value={fmt(m.perUnitTotal)}
        />
        <Line label={t('testing.potTotal')} value={fmt(m.pot)} strong />
      </Section>
      <Section
        header={t('testing.potTiers')}
        footer={t('testing.potUnitValue', { amount: fmt(m.unitValue), orders: m.orders })}
      >
        {steps.map((step) => (
          <Cell
            key={step.tier.id}
            before={
              <span className="gb-testing-tier-icon" aria-hidden="true">
                {step.upgradedTo ? '⬆️' : step.reached ? '✅' : step === next ? '⏳' : '🔒'}
              </span>
            }
            after={<span className="gb-testing-money">{fmt(step.cost + step.vialCost)}</span>}
            subtitle={
              step.upgradedTo
                ? t('testing.tierUpgradedTo', { tier: step.upgradedTo.name })
                : step.reached
                  ? t('testing.tierReached')
                  : step.unitsLeft !== null
                    ? t('testing.potMissingUnits', { amount: fmt(step.missing), units: units(step.unitsLeft) })
                    : t('testing.potMissing', { amount: fmt(step.missing) })
            }
            multiline
          >
            {step.tier.name}
          </Cell>
        ))}
        <Line label={t('testing.potBalance')} value={fmt(m.balance)} strong />
      </Section>
    </>
  );
}

/**
 * Trying numbers before opening (or while open): units and orders expected,
 * and which tiers the pot would cover.
 */
function Simulator({
  tiers,
  fee,
  perUnit,
  vialPrice,
  currency,
}: {
  tiers: readonly TestingTier[];
  fee: number;
  perUnit: number;
  vialPrice: number;
  currency: string;
}): React.JSX.Element {
  const [unitsText, setUnitsText] = useState('');
  const [ordersText, setOrdersText] = useState('');
  const fmt = (amount: number): string => formatPrice(amount, currency);
  const u = COUNT_RE.test(unitsText.trim()) ? Number(unitsText) : 0;
  const o = COUNT_RE.test(ordersText.trim()) ? Number(ordersText) : 0;
  const pot = o * fee + u * perUnit;
  const steps = tierSteps({ tiers, pot, vialPrice, unitValue: perUnit > 0 ? perUnit : fee });
  return (
    <Section header={t('testing.simTitle')} footer={t('testing.simFooter')}>
      <div className="gb-testing-tier-row">
        <div style={{ flex: 1 }}>
          <Input
            header={t('testing.simUnits')}
            type="text"
            inputMode="numeric"
            placeholder="80"
            value={unitsText}
            onChange={(e) => setUnitsText(e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Input
            header={t('testing.simOrders')}
            type="text"
            inputMode="numeric"
            placeholder="35"
            value={ordersText}
            onChange={(e) => setOrdersText(e.target.value)}
          />
        </div>
      </div>
      {(u > 0 || o > 0) && (
        <>
          <Line label={t('testing.simPot')} value={fmt(pot)} strong />
          {steps.map((step) => (
            <Cell
              key={step.tier.id}
              before={
                <span className="gb-testing-tier-icon" aria-hidden="true">
                  {step.reached ? '✅' : '⏳'}
                </span>
              }
              after={<span className="gb-testing-money">{fmt(step.needed)}</span>}
              subtitle={step.reached ? undefined : t('testing.potMissing', { amount: fmt(step.missing) })}
              multiline
            >
              {step.tier.name}
            </Cell>
          ))}
        </>
      )}
    </Section>
  );
}

/** Who takes part: paid first, then those still to pay; tap one to see the order. */
function Participants({ testing }: { testing: Testing }): React.JSX.Element | null {
  const navigate = useNavigate();
  const { to } = useShop();
  const list = useAsync(() => api.adminGetTestingParticipants(testing.id), [testing.id]);
  if (!list.data) return null;
  const fmt = (amount: number): string => formatPrice(amount, testing.currency);
  const volunteers = list.data.filter((p) => p.volunteer).length;
  const perUnit = testing.money?.perUnit ?? 0;
  return (
    <Section
      header={t('testing.participants', { count: list.data.length })}
      footer={t('testing.participantsMoneyFooter', { payers: testing.participants, volunteers })}
    >
      {list.data.length === 0 && <Cell multiline>{t('testing.noParticipants')}</Cell>}
      {list.data.map((p) => (
        <Cell
          key={p.orderId}
          onClick={() => navigate(to(`/admin/orders/${p.orderId}`))}
          subtitle={[
            units(p.units),
            p.extra > 0 ? t('testing.participantExtra', { amount: fmt(p.extra) }) : null,
            perUnit > 0 ? t('testing.participantHidden', { amount: fmt(perUnit * p.units) }) : null,
            p.paid ? t('testing.paid') : t('testing.unpaid'),
            p.volunteer ? t('testing.volunteerChip') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          after={p.exempt ? t('testing.exemptChip') : fmt(p.amount)}
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
        : blocker === 'extra_open'
          ? t('testing.drawExtraOpen')
          : blocker === 'donations_open'
          ? t('testing.drawDonationsOpen', {
              date: testing.donationsUntil ? formatDateTime(testing.donationsUntil) : '—',
            })
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
 * Closing the testing once drawn (or when no tier was reached): donors get the
 * price of their vial back on their order; the fees stay.
 */
function SettleSection({ testing, onChange }: { testing: Testing; onChange: () => void }): React.JSX.Element | null {
  const actions = useAdminActions(onChange);
  const nothingReached = !testing.tiers.some((tier) => tier.reached);
  if (testing.status === 'settled') {
    return (
      <Section header={t('testing.settleTitle')}>
        <Cell multiline>{t('testing.settledDone')}</Cell>
      </Section>
    );
  }
  if (testing.status !== 'drawn' && !(testing.status === 'closed' && nothingReached)) return null;
  return (
    <Section
      header={t('testing.settleTitle')}
      footer={testing.status === 'closed' ? t('testing.settleNothingFooter') : t('testing.settleVialsFooter')}
    >
      <ErrorBanner message={actions.error} />
      <div style={{ padding: 16 }}>
        <Button
          stretched
          onClick={() => void actions.twoTap('settle', () => api.adminSettleTesting(testing.id))}
        >
          {actions.tapLabel('settle', t('testing.settleClose'))}
        </Button>
      </div>
    </Section>
  );
}

/**
 * The time to join and give opens again: on a closed testing before the draw
 * and the extra round, or on one settled with nothing reached.
 */
function ReopenSection({ testing, onChange }: { testing: Testing; onChange: () => void }): React.JSX.Element | null {
  const actions = useAdminActions(onChange);
  const [hours, setHours] = useState(String(testing.donationHours > 0 ? testing.donationHours : 24));
  const fresh = testing.draw === null && testing.extra === null;
  const closedNow = testing.status === 'closed' && !testing.donationsOpen;
  if (!fresh || !(closedNow || testing.status === 'settled')) return null;
  const valid = /^\d+$/.test(hours) && Number(hours) >= 1 && Number(hours) <= MAX_DONATION_HOURS;
  return (
    <Section header={t('testing.reopenTitle')} footer={t('testing.reopenFooter')}>
      <ErrorBanner message={actions.error} />
      <Input
        header={t('testing.reopenHours')}
        inputMode="numeric"
        value={hours}
        status={valid ? 'default' : 'error'}
        onChange={(e) => setHours(e.target.value)}
      />
      <div style={{ padding: 16 }}>
        <Button
          stretched
          disabled={!valid}
          onClick={() => void actions.twoTap('reopen', () => api.adminReopenTesting(testing.id, Number(hours)))}
        >
          {actions.tapLabel('reopen', t('testing.reopen'))}
        </Button>
      </div>
    </Section>
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
          {t('testing.reportSentOn', { date: formatDateTime(testing.reportSentAt) })}
        </Cell>
      )}
      {asked && <Cell multiline>{t('testing.reportAsked')}</Cell>}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
        {/* The tests the extra round paid: their own report, for those who paid it. */}
        {(testing.extra?.outcome?.tiers.length ?? 0) > 0 && (
          <Button
            stretched
            mode="bezeled"
            onClick={() =>
              void actions.run(async () => {
                await api.adminRequestTestingReport(testing.id, 'extra');
                setAsked(true);
              })
            }
          >
            {testing.extraReportSentAt
              ? t('testing.extraReportAgain', { date: formatDateTime(testing.extraReportSentAt) })
              : t('testing.extraReportSend')}
          </Button>
        )}
      </div>
    </Section>
  );
}

/** Cancelling: everything paid for it goes back. */
function CancelSection({ testing, onChange }: { testing: Testing; onChange: () => void }): React.JSX.Element | null {
  const actions = useAdminActions(onChange);
  if (testing.status === 'settled' || testing.status === 'cancelled') return null;
  if ((testing.money?.entries ?? 0) === 0) return null;
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

/** The extra round, for the organiser: where it is, what is missing and how it went. */
function ExtraStatus({ testing }: { testing: Testing }): React.JSX.Element | null {
  const extra = testing.extra;
  if (!extra) return null;
  const fmt = (amount: number): string => formatPrice(amount, testing.currency);
  const until = formatDateTime(extra.until);
  return (
    <Section header={t('testing.extraStatusTitle')}>
      <Cell multiline subtitle={extra.stage === 'done' ? undefined : t('testing.extraUntil', { date: until })}>
        {t(`testing.extraStage.${extra.stage}`)}
      </Cell>
      {extra.stage === 'signup' &&
        extra.missing.map((m) => (
          <Cell key={m.id} after={<span className="gb-testing-money">{fmt(m.amount)}</span>}>
            {m.name}
          </Cell>
        ))}
      {extra.stage === 'signup' && (
        <Cell multiline>
          {t('testing.extraSigned', { count: extra.signed })}
          {extra.estimate.share !== null
            ? ` · ${t('testing.extraEstimate', { tiers: extra.estimate.tiers.join(', '), amount: fmt(extra.estimate.share) })}`
            : ''}
        </Cell>
      )}
      {extra.stage === 'pay' && (
        <Cell multiline>
          {t('testing.extraPaying', {
            tiers: extra.estimate.tiers.join(', '),
            amount: extra.estimate.share !== null ? fmt(extra.estimate.share) : '—',
          })}
        </Cell>
      )}
      {(extra.stage === 'round' || extra.stage === 'topup') && extra.round && (
        <Cell after={<span className="gb-testing-money">{fmt(extra.round.gap)}</span>}>
          {t('testing.extraGap')}
        </Cell>
      )}
      {extra.outcome && (
        <Cell multiline>
          {t('testing.extraOutcome', {
            tiers:
              testing.tiers
                .filter((tier) => extra.outcome?.tiers.includes(tier.id))
                .map((tier) => tier.name)
                .join(', ') || '—',
            collected: fmt(extra.outcome.collected),
            refunded: fmt(extra.outcome.refunded),
          })}
        </Cell>
      )}
    </Section>
  );
}
