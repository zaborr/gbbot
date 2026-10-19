import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../../components/Field.js';
import { toMajor } from './common.js';
import { t } from '../../i18n/index.js';

/** Fixed fee added once to every new order; 0 hides it everywhere. */
export function OrderFeeForm({
  fee,
  label,
  vipNoFee,
  onSave,
}: {
  fee: number;
  label: string;
  /** VIPs do not pay the fee. */
  vipNoFee: boolean;
  onSave: (fee: number, label: string, vipNoFee: boolean) => Promise<void>;
}): React.JSX.Element {
  const [amount, setAmount] = useState(fee > 0 ? toMajor(fee) : '0');
  const [name, setName] = useState(label);
  const [vipFree, setVipFree] = useState(vipNoFee);
  const [busy, setBusy] = useState(false);

  const value = amount.trim().replace(',', '.');
  const invalid = !/^\d+(\.\d{1,2})?$/.test(value) || !name.trim();
  const cents = invalid ? 0 : Math.round(Number(value) * 100);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await onSave(cents, name.trim(), vipFree);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      header={t('fee.title')}
      footer={fee > 0 ? t('fee.footerOn', { label }) : t('fee.footerOff')}
    >
      <Input
        header={t('fee.amount')}
        type="text"
        inputMode="decimal"
        status={invalid ? 'error' : 'default'}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <Input
        header={t('fee.name')}
        placeholder={t('cart.serviceFee')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Cell
        multiline
        subtitle={t('fee.vipNoFeeHint')}
        after={
          <Button size="s" mode={vipFree ? 'filled' : 'bezeled'} onClick={() => setVipFree((v) => !v)}>
            {vipFree ? t('common.on') : t('common.off')}
          </Button>
        }
      >
        {t('fee.vipNoFee')}
      </Cell>
      <div style={{ padding: 16 }}>
        <Button
          stretched
          mode="bezeled"
          loading={busy}
          disabled={invalid || (cents === fee && name.trim() === label && vipFree === vipNoFee)}
          onClick={() => void save()}
        >
          {t('fee.save')}
        </Button>
      </div>
    </Section>
  );
}
