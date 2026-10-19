import { useState } from 'react';
import { Button, Cell, Section, Switch } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { Input } from '../../components/Field.js';
import { GoalBar } from '../../components/GoalBar.js';
import { ErrorBanner, toMajor, useAdminActions } from './common.js';
import { t } from '../../i18n/index.js';

/** The minimum the GB needs to go ahead (products only), and what customers see of it. */
export function GoalSection(): React.JSX.Element | null {
  const view = useAsync(() => api.adminGetShop(), []);
  if (!view.data) return null;
  return <GoalForm amount={view.data.goalAmount} showAmount={view.data.goalShowAmount} />;
}

function GoalForm({ amount, showAmount }: { amount: number | null; showAmount: boolean }): React.JSX.Element {
  const { shop, reload } = useShop();
  const actions = useAdminActions(reload);
  const [text, setText] = useState(amount ? toMajor(amount) : '');
  const [show, setShow] = useState(showAmount);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const value = text.trim().replace(',', '.');
  const invalid = value !== '' && (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) <= 0);

  const save = async (): Promise<void> => {
    setBusy(true);
    setSaved(false);
    await actions.run(async () => {
      await api.adminUpdateGoal(value === '' ? null : Math.round(Number(value) * 100), show);
      setSaved(true);
    });
    setBusy(false);
  };

  return (
    <>
      <ErrorBanner message={actions.error} />
      <Section header={t('goalAdmin.title')} footer={t('goalAdmin.footer')}>
        {shop.goal && (
          <div style={{ padding: '12px 16px' }}>
            <GoalBar goal={shop.goal} closesAt={shop.closesAt} />
          </div>
        )}
        <Input
          header={invalid ? t('goalAdmin.invalid') : t('goalAdmin.amount', { token: shop.currency })}
          placeholder={t('goalAdmin.none')}
          type="text"
          inputMode="decimal"
          status={invalid ? 'error' : 'default'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Cell
          Component="label"
          after={<Switch checked={show} onChange={(e) => setShow(e.target.checked)} />}
          subtitle={show ? t('goalAdmin.showAmountOn') : t('goalAdmin.showAmountOff')}
          multiline
        >
          {t('goalAdmin.showAmount')}
        </Cell>
        <div style={{ padding: 16 }}>
          <Button stretched mode="bezeled" loading={busy} disabled={invalid} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
        {saved && <Cell>{t('common.saved')}</Cell>}
      </Section>
    </>
  );
}
