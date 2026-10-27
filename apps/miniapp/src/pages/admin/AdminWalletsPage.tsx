import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import {
  CHAINS,
  EVM_ADDRESS_RE,
  RATE_SCALE,
  SOLANA_ADDRESS_RE,
  paymentMethodsOf,
  stableToken,
  type ChainId,
  type ManualPaymentMethod,
  type PaymentSetup,
  type StableToken,
} from '@tma-shop/shared';
import { Input, Textarea } from '../../components/Field.js';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { AdminOnly, ErrorBanner, toMajor, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t, tn } from '../../i18n/index.js';

/** The receiving addresses and the networks/tokens the shop accepts. */
export function AdminWalletsPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminWallets />
    </AdminOnly>
  );
}

function AdminWallets(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const [saved, setSaved] = useState(false);
  const view = useAsync(() => api.adminGetShop(), [reloadKey]);

  if (view.loading && !view.data) return <Loader />;
  if (view.error) return <ErrorView message={view.error} />;
  if (!view.data) return <Loader />;

  return (
    <PaymentsForm
      key={view.version}
      setup={view.data.paymentSetup}
      saved={saved}
      onSaved={() => {
        setSaved(true);
        setReloadKey((k) => k + 1);
      }}
    />
  );
}

function PaymentsForm({
  setup,
  saved,
  onSaved,
}: {
  setup: PaymentSetup;
  saved: boolean;
  onSaved: () => void;
}): React.JSX.Element {
  const { reload, shop } = useShop();
  // Where the money goes: only the GB's administrators change it.
  const readOnly = !shop.canOwn;
  const actions = useAdminActions(() => {
    onSaved();
    reload();
  });
  const [evm, setEvm] = useState(setup.evmAddress ?? '');
  const [solana, setSolana] = useState(setup.solanaAddress ?? '');
  const [accepted, setAccepted] = useState(setup.accepted);
  const [manual, setManual] = useState<ManualPaymentMethod[]>(setup.manual ?? []);
  // Exchange rates typed as decimals ("1.10"); empty = that direction is off.
  const shownRate = (value: number | null | undefined): string =>
    value ? String(value / RATE_SCALE) : '';
  const [eurToUsd, setEurToUsd] = useState(shownRate(setup.exchange?.EURC));
  const [usdToEur, setUsdToEur] = useState(shownRate(setup.exchange?.USDC));
  const [busy, setBusy] = useState(false);
  const parseRate = (text: string): number | null | 'invalid' => {
    const value = text.trim().replace(',', '.');
    if (value === '') return null;
    if (!/^\d+(\.\d{1,4})?$/.test(value) || Number(value) <= 0 || Number(value) > 100) return 'invalid';
    return Math.round(Number(value) * RATE_SCALE);
  };
  const eurRate = parseRate(eurToUsd);
  const usdRate = parseRate(usdToEur);
  const rateInvalid = eurRate === 'invalid' || usdRate === 'invalid';

  const evmValue = evm.trim();
  const solanaValue = solana.trim();
  const evmInvalid = evmValue !== '' && !EVM_ADDRESS_RE.test(evmValue);
  const solanaInvalid = solanaValue !== '' && !SOLANA_ADDRESS_RE.test(solanaValue);
  const manualNames = manual.map((m) => m.name.trim().toLowerCase());
  const manualInvalid = manual.some(
    (m, i) => !m.name.trim() || !m.instructions.trim() || manualNames.indexOf(manualNames[i] ?? '') !== i,
  );
  const next: PaymentSetup = {
    evmAddress: evmValue && !evmInvalid ? evmValue : null,
    solanaAddress: solanaValue && !solanaInvalid ? solanaValue : null,
    // Only networks whose address is set.
    accepted: accepted.filter((a) =>
      CHAINS[a.chain].family === 'evm' ? evmValue !== '' : solanaValue !== '',
    ),
    manual: manual.map((m) => ({ ...m, name: m.name.trim(), instructions: m.instructions.trim() })),
    exchange: {
      EURC: eurRate === 'invalid' ? null : eurRate,
      USDC: usdRate === 'invalid' ? null : usdRate,
    },
  };
  const manualActive = manual.filter((m) => m.isActive).length;
  const updateManual = (index: number, patch: Partial<ManualPaymentMethod>): void =>
    setManual((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const methods = paymentMethodsOf(next);

  const isOn = (chain: ChainId, token: StableToken): boolean =>
    accepted.some((a) => a.chain === chain && a.token === token);
  const toggle = (chain: ChainId, token: StableToken): void =>
    setAccepted((prev) =>
      isOn(chain, token)
        ? prev.filter((a) => !(a.chain === chain && a.token === token))
        : [...prev, { chain, token }],
    );

  const save = async (): Promise<void> => {
    setBusy(true);
    await actions.run(() => api.adminUpdatePayments(next));
    setBusy(false);
  };

  /** USDC / EURC toggles for one network. */
  const tokenRow = (chain: ChainId, hasAddress: boolean): React.JSX.Element => (
    <Cell
      key={chain}
      subtitle={hasAddress ? t('wallets.accept') : t('wallets.needAddress')}
      after={
        <div style={{ display: 'flex', gap: 8 }}>
          {stableToken.options.map((token) => (
            <Button
              key={token}
              size="s"
              disabled={!hasAddress}
              mode={hasAddress && isOn(chain, token) ? 'filled' : 'bezeled'}
              onClick={() => toggle(chain, token)}
            >
              {token}
            </Button>
          ))}
        </div>
      }
    >
      {CHAINS[chain].name}
    </Cell>
  );

  return (
    <List>
      <PageTitle title={t('adminHome.wallets')} />
      <ErrorBanner message={actions.error} />
      <Section>
        <Cell multiline>{t('wallets.intro')}</Cell>
        {readOnly && <Cell multiline>{t('owner.readOnly')}</Cell>}
      </Section>

      <Section header={t('wallets.evmTitle')} footer={t('wallets.evmFooter')}>
        <Input
          header={evmInvalid ? t('wallets.evmInvalid') : t('wallets.evmAddress')}
          placeholder="0x…"
          status={evmInvalid ? 'error' : 'default'}
          value={evm}
          onChange={(e) => setEvm(e.target.value)}
        />
        {tokenRow('base', evmValue !== '' && !evmInvalid)}
        {tokenRow('ethereum', evmValue !== '' && !evmInvalid)}
      </Section>

      <Section header={t('wallets.solanaTitle')} footer={t('wallets.solanaFooter')}>
        <Input
          header={solanaInvalid ? t('wallets.solanaInvalid') : t('wallets.solanaAddress')}
          status={solanaInvalid ? 'error' : 'default'}
          value={solana}
          onChange={(e) => setSolana(e.target.value)}
        />
        {tokenRow('solana', solanaValue !== '' && !solanaInvalid)}
      </Section>

      <Section header={t('exchange.title')} footer={t('exchange.footer')}>
        <Input
          header={eurRate === 'invalid' ? t('exchange.invalid') : t('exchange.eurToUsd')}
          placeholder={t('exchange.off')}
          type="text"
          inputMode="decimal"
          status={eurRate === 'invalid' ? 'error' : 'default'}
          value={eurToUsd}
          onChange={(e) => setEurToUsd(e.target.value)}
        />
        <Input
          header={usdRate === 'invalid' ? t('exchange.invalid') : t('exchange.usdToEur')}
          placeholder={t('exchange.off')}
          type="text"
          inputMode="decimal"
          status={usdRate === 'invalid' ? 'error' : 'default'}
          value={usdToEur}
          onChange={(e) => setUsdToEur(e.target.value)}
        />
      </Section>

      <OverpayMarginSection readOnly={readOnly} />

      <Section header={t('manualPay.title')} footer={t('manualPay.footer')}>
        {manual.map((m, index) => {
          const duplicate = manualNames.indexOf(manualNames[index] ?? '') !== index;
          return (
            <div key={m.id} style={{ paddingBottom: 8 }}>
              <Input
                header={duplicate ? t('manualPay.duplicate') : t('manualPay.name')}
                placeholder="Wise"
                status={duplicate ? 'error' : 'default'}
                maxLength={40}
                value={m.name}
                onChange={(e) => updateManual(index, { name: e.target.value })}
              />
              <Textarea
                header={t('manualPay.instructions')}
                placeholder={t('manualPay.instructionsPlaceholder')}
                maxLength={1000}
                value={m.instructions}
                onChange={(e) => updateManual(index, { instructions: e.target.value })}
              />
              <div style={{ display: 'flex', gap: 8, padding: '8px 16px' }}>
                <Button
                  size="s"
                  mode={m.isActive ? 'filled' : 'bezeled'}
                  onClick={() => updateManual(index, { isActive: !m.isActive })}
                >
                  {m.isActive ? t('manualPay.active') : t('manualPay.inactive')}
                </Button>
                <Button
                  size="s"
                  mode="plain"
                  onClick={() => setManual((prev) => prev.filter((_, i) => i !== index))}
                >
                  {t('manualPay.remove')}
                </Button>
              </div>
            </div>
          );
        })}
        {manual.length < 10 && (
          <Cell
            onClick={() =>
              setManual((prev) => [
                ...prev,
                { id: newMethodId(), name: '', instructions: '', isActive: true },
              ])
            }
          >
            {t('manualPay.add')}
          </Cell>
        )}
      </Section>

      <Section
        footer={
          methods.length + manualActive > 0
            ? t('wallets.summary', {
                options: tn(
                  methods.length + manualActive,
                  'count.paymentOptions.one',
                  'count.paymentOptions.other',
                ),
              })
            : t('wallets.none')
        }
      >
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={readOnly || evmInvalid || solanaInvalid || manualInvalid || rateInvalid}
            onClick={() => void save()}
          >
            {t('wallets.save')}
          </Button>
        </div>
        {saved && <Cell multiline>{t('wallets.saved')}</Cell>}
      </Section>
    </List>
  );
}

/** A new id for a manual method (orders keep pointing at it). */
function newMethodId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Overpayment margin: paying up to this much too much counts as paying the
 * price (no refund noted). Saved on its own; administrators only.
 */
function OverpayMarginSection({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const { shop, reload } = useShop();
  const actions = useAdminActions(reload);
  const [text, setText] = useState(shop.overpayMargin > 0 ? toMajor(shop.overpayMargin) : '');
  const [busy, setBusy] = useState(false);
  const value = text.trim() === '' ? 0 : Math.round(Number(text.replace(',', '.')) * 100);
  const invalid = !Number.isFinite(value) || value < 0 || value > 10_000;

  return (
    <Section
      header={t('margin.title')}
      footer={t('margin.footer', { currency: shop.currency })}
    >
      <ErrorBanner message={actions.error} />
      <Input
        header={invalid ? t('margin.invalid') : t('margin.amount', { currency: shop.currency })}
        placeholder="0.00"
        type="text"
        inputMode="decimal"
        status={invalid ? 'error' : 'default'}
        disabled={readOnly}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ padding: 16 }}>
        <Button
          stretched
          mode="bezeled"
          loading={busy}
          disabled={readOnly || invalid || value === shop.overpayMargin}
          onClick={() => {
            setBusy(true);
            void actions
              .run(() => api.adminUpdateOverpayMargin(value))
              .finally(() => setBusy(false));
          }}
        >
          {t('common.save')}
        </Button>
      </div>
    </Section>
  );
}
