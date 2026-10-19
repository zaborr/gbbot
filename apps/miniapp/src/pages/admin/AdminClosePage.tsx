import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Input } from '../../components/Field.js';
import { closingDate } from '../../components/ClosingNotice.js';
import { useShop } from '../../providers/ShopProvider.js';
import { GoalSection } from './GoalSection.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t } from '../../i18n/index.js';

/** ISO date → value for `<input type="datetime-local">` (local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** Close the GB now or on a date, or open it again. */
export function AdminClosePage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminClose />
    </AdminOnly>
  );
}

function AdminClose(): React.JSX.Element {
  const { shop, reload } = useShop();
  const actions = useAdminActions(reload);
  const [when, setWhen] = useState(toLocalInput(shop.closesAt));
  const [warn, setWarn] = useState(String(shop.closingWarnHours));
  const warnHours = Number(warn);
  const warnValid = Number.isInteger(warnHours) && warnHours >= 0 && warnHours <= 720;
  const preview = useAsync(
    () => (shop.isClosed ? Promise.resolve(null) : api.adminClosePreview()),
    [shop.isClosed],
  );

  const whenDate = when ? new Date(when) : null;
  const whenValid = whenDate !== null && !Number.isNaN(whenDate.getTime()) && whenDate > new Date();

  if (shop.isClosed) {
    return (
      <List>
      <PageTitle title={t('adminHome.close')} />
        <ErrorBanner message={actions.error} />
        <Section header={t('close.title')} footer={t('close.closedFooter')}>
          <Cell multiline before={<span style={{ fontSize: 22 }}>🔒</span>}>
            {shop.closedAt
              ? t('close.closedSince', { date: closingDate(shop.closedAt) })
              : t('closed.title')}
          </Cell>
          <div style={{ padding: 16 }}>
            <Button
              stretched
              mode="bezeled"
              onClick={() => void actions.twoTap('reopen', () => api.adminReopenShop())}
            >
              {actions.tapLabel('reopen', t('close.reopen'))}
            </Button>
          </div>
        </Section>
        <GoalSection />
      </List>
    );
  }

  const counts = preview.data;
  return (
    <List>
      <PageTitle title={t('adminHome.close')} />
      <ErrorBanner message={actions.error} />

      <GoalSection />

      <Section header={t('close.scheduleTitle')} footer={t('close.scheduleFooter')}>
        {shop.closesAt && (
          <Cell multiline before={<span style={{ fontSize: 22 }}>⏳</span>}>
            {t('closing.title', { date: closingDate(shop.closesAt) })}
          </Cell>
        )}
        <Input
          header={t('close.when')}
          type="datetime-local"
          status={when !== '' && !whenValid ? 'error' : 'default'}
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <Input
          header={t('close.warnHours')}
          inputMode="numeric"
          status={warnValid ? 'default' : 'error'}
          value={warn}
          onChange={(e) => setWarn(e.target.value)}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 16 }}>
          <Button
            size="s"
            disabled={!whenValid || !warnValid}
            onClick={() =>
              void actions.run(() =>
                api.adminScheduleClosing(whenDate ? whenDate.toISOString() : null, warnHours),
              )
            }
          >
            {t('close.schedule')}
          </Button>
          {shop.closesAt && (
            <Button
              size="s"
              mode="bezeled"
              onClick={() =>
                void actions.run(async () => {
                  setWhen('');
                  await api.adminScheduleClosing(null);
                })
              }
            >
              {t('close.unschedule')}
            </Button>
          )}
        </div>
      </Section>

      <Section header={t('close.nowTitle')} footer={t('close.nowFooter')}>
        {counts && (
          <Cell multiline>
            {[
              t('close.willDeleteOrders', { count: counts.unpaidOrders }),
              t('close.willEmptyCarts', { count: counts.carts }),
              counts.pendingChanges > 0
                ? t('close.willRejectChanges', { count: counts.pendingChanges })
                : null,
              counts.paymentsToReview > 0
                ? t('close.paymentsStay', { count: counts.paymentsToReview })
                : null,
            ]
              .filter(Boolean)
              .join('\n')}
          </Cell>
        )}
        <div style={{ padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            style={{ color: 'var(--tgui--destructive_text_color)' }}
            onClick={() => void actions.twoTap('close', () => api.adminCloseShop())}
          >
            {actions.tapLabel('close', t('close.now'), t('close.nowConfirm'))}
          </Button>
        </div>
      </Section>
    </List>
  );
}
