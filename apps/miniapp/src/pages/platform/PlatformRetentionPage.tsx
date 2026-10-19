import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../../components/Field.js';
import type { RetentionReport, RetentionStatus } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { ErrorBanner, formatDate, useAdminActions } from '../admin/common.js';
import { t } from '../../i18n/index.js';

/** Platform super-admin: how long personal data is kept, and a manual cleanup. */
export function PlatformRetentionPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <Retention />;
}

function Retention(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const status = useAsync(() => api.platformGetRetention(), [reloadKey]);

  if (status.loading && !status.data) return <Loader />;
  if (status.error) return <ErrorView message={status.error} />;
  if (!status.data) return <Loader />;
  return (
    <RetentionForm
      key={status.version}
      status={status.data}
      onSaved={() => setReloadKey((k) => k + 1)}
    />
  );
}

function days(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
}

function RetentionForm({
  status,
  onSaved,
}: {
  status: RetentionStatus;
  onSaved: () => void;
}): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [address, setAddress] = useState(String(status.addressRetentionDays));
  const [carts, setCarts] = useState(String(status.cartRetentionDays));
  const [usersDays, setUsersDays] = useState(String(status.inactiveUserDays));
  const [saved, setSaved] = useState(false);
  const [report, setReport] = useState<RetentionReport | null>(null);

  const values = {
    addressRetentionDays: days(address),
    cartRetentionDays: days(carts),
    inactiveUserDays: days(usersDays),
  };
  const valid = Object.values(values).every((v) => v !== null);

  const save = (): void =>
    void actions.run(async () => {
      if (
        values.addressRetentionDays === null ||
        values.cartRetentionDays === null ||
        values.inactiveUserDays === null
      ) {
        return;
      }
      await api.platformUpdateRetention({
        addressRetentionDays: values.addressRetentionDays,
        cartRetentionDays: values.cartRetentionDays,
        inactiveUserDays: values.inactiveUserDays,
      });
      setSaved(true);
      onSaved();
    });

  return (
    <List>
      <ErrorBanner message={actions.error} />

      <Section
        header={t('retention.title')}
        footer={t('retention.footer')}
      >
        <Input
          header={t('retention.orders')}
          inputMode="numeric"
          status={values.addressRetentionDays === null ? 'error' : 'default'}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <Input
          header={t('retention.carts')}
          inputMode="numeric"
          status={values.cartRetentionDays === null ? 'error' : 'default'}
          value={carts}
          onChange={(e) => setCarts(e.target.value)}
        />
        <Input
          header={t('retention.users')}
          inputMode="numeric"
          status={values.inactiveUserDays === null ? 'error' : 'default'}
          value={usersDays}
          onChange={(e) => setUsersDays(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button stretched disabled={!valid} onClick={save}>
            {saved ? t('common.saved') : t('common.save')}
          </Button>
        </div>
      </Section>

      <Section
        header={t('retention.kept')}
        footer={t('retention.keptFooter')}
      >
        <Cell multiline>
          {t('retention.usersStore')}
        </Cell>
      </Section>

      <Section
        header={t('retention.runNow')}
        footer={
          status.lastRunAt
            ? t('retention.lastRun', { date: formatDate(status.lastRunAt) })
            : t('retention.neverRun')
        }
      >
        {report && (
          <Cell multiline>
            {t('retention.report', {
              orders: report.ordersAnonymized,
              carts: report.cartsDeleted,
              users: report.usersDeleted,
            })}
          </Cell>
        )}
        <div style={{ padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            onClick={() =>
              void actions.twoTap('run', async () => {
                setReport(await api.platformRunRetention());
              })
            }
          >
            {actions.tapLabel('run', t('retention.run'), t('retention.runConfirm'))}
          </Button>
        </div>
      </Section>
    </List>
  );
}
