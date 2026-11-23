import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../../components/Field.js';
import { toMajor } from './common.js';
import { t } from '../../i18n/index.js';

type VipMode = 'same' | 'none' | 'reduced';

const modeOf = (vipFee: number | null): VipMode => (vipFee === null ? 'same' : vipFee === 0 ? 'none' : 'reduced');

/** "12.5" or "12,50" → 1250; null when it is not an amount. */
function cents(text: string): number | null {
  const value = text.trim().replace(',', '.');
  return /^\d+(\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : null;
}

/** Fixed fee added once to every new order (0 hides it), and what VIPs pay instead. */
export function OrderFeeForm({
  fee,
  label,
  vipFee,
  onSave,
}: {
  fee: number;
  label: string;
  /** What VIPs pay: null = the same as everyone, 0 = nothing. */
  vipFee: number | null;
  onSave: (fee: number, label: string, vipFee: number | null) => Promise<void>;
}): React.JSX.Element {
  const [amount, setAmount] = useState(fee > 0 ? toMajor(fee) : '0');
  const [name, setName] = useState(label);
  const [mode, setMode] = useState<VipMode>(modeOf(vipFee));
  const [vipAmount, setVipAmount] = useState(vipFee !== null && vipFee > 0 ? toMajor(vipFee) : '');
  const [busy, setBusy] = useState(false);

  const value = cents(amount);
  const vipValue = mode === 'same' ? null : mode === 'none' ? 0 : cents(vipAmount);
  const vipInvalid = mode === 'reduced' && (vipValue === null || vipValue === 0);
  const invalid = value === null || !name.trim() || vipInvalid;
  const unchanged = value === fee && name.trim() === label && vipValue === vipFee;

  const save = async (): Promise<void> => {
    if (value === null) return;
    setBusy(true);
    try {
      await onSave(value, name.trim(), vipValue);
    } finally {
      setBusy(false);
    }
  };

  const modes: Array<{ key: VipMode; label: string }> = [
    { key: 'same', label: t('fee.vipSame') },
    { key: 'none', label: t('fee.vipNone') },
    { key: 'reduced', label: t('fee.vipReduced') },
  ];

  return (
    <Section
      header={t('fee.title')}
      footer={fee > 0 ? t('fee.footerOn', { label }) : t('fee.footerOff')}
    >
      <Input
        header={t('fee.amount')}
        type="text"
        inputMode="decimal"
        status={value === null ? 'error' : 'default'}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Input
        header={t('fee.name')}
        placeholder={t('cart.serviceFee')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Cell multiline subtitle={t('fee.vipHint')}>
        {t('fee.vipTitle')}
      </Cell>
      <div style={{ display: 'flex', gap: 8, padding: '0 16px 8px' }}>
        {modes.map((m) => (
          <Button
            key={m.key}
            stretched
            size="s"
            mode={mode === m.key ? 'filled' : 'bezeled'}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </Button>
        ))}
      </div>
      {mode === 'reduced' && (
        <Input
          header={t('fee.vipAmount')}
          type="text"
          inputMode="decimal"
          status={vipInvalid && vipAmount !== '' ? 'error' : 'default'}
          value={vipAmount}
          onChange={(e) => setVipAmount(e.target.value)}
        />
      )}
      <div style={{ padding: 16 }}>
        <Button
          stretched
          mode="bezeled"
          loading={busy}
          disabled={invalid || unchanged}
          onClick={() => void save()}
        >
          {t('fee.save')}
        </Button>
      </div>
    </Section>
  );
}
