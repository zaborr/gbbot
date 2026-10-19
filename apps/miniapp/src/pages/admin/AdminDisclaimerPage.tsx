import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { DisclaimerAdminView } from '@tma-shop/shared';
import { Textarea } from '../../components/Field.js';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { useShop } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t } from '../../i18n/index.js';

/** The text customers accept before entering the GB. */
export function AdminDisclaimerPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminDisclaimer />
    </AdminOnly>
  );
}

function AdminDisclaimer(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const view = useAsync(() => api.adminGetDisclaimer(), [reloadKey]);
  if (view.loading && !view.data) return <Loader />;
  if (view.error) return <ErrorView message={view.error} />;
  if (!view.data) return <Loader />;
  return <DisclaimerForm key={view.version} view={view.data} onSaved={() => setReloadKey((k) => k + 1)} />;
}

function DisclaimerForm({ view, onSaved }: { view: DisclaimerAdminView; onSaved: () => void }): React.JSX.Element {
  const { reload } = useShop();
  const actions = useAdminActions(() => {
    onSaved();
    reload();
  });
  const [text, setText] = useState(view.text);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = view.version > 0;
  const value = text.trim();
  const changed = value !== view.text.trim();

  const save = async (askAgain: boolean): Promise<void> => {
    setBusy(true);
    await actions.run(() => api.adminUpdateDisclaimer(value, askAgain));
    setBusy(false);
    setAsking(false);
  };

  return (
    <List>
      <PageTitle title={t('disclaimerAdmin.menu')} />
      <ErrorBanner message={actions.error} />
      <Section header={t('disclaimerAdmin.title')} footer={t('disclaimerAdmin.footer')}>
        <Textarea
          header={t('disclaimerAdmin.text')}
          placeholder={t('disclaimerAdmin.placeholder')}
          maxLength={4000}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setAsking(false);
          }}
        />
        {active && (
          <Cell after={String(view.accepted)}>{t('disclaimerAdmin.accepted')}</Cell>
        )}
      </Section>

      <Section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          {asking ? (
            <>
              <Cell multiline>{t('disclaimerAdmin.howChanged')}</Cell>
              <Button stretched loading={busy} onClick={() => void save(true)}>
                {t('disclaimerAdmin.askAgain')}
              </Button>
              <Button stretched mode="bezeled" loading={busy} onClick={() => void save(false)}>
                {t('disclaimerAdmin.minor')}
              </Button>
              <Button stretched mode="plain" onClick={() => setAsking(false)}>
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <Button
              stretched
              loading={busy}
              disabled={!changed}
              // A change to a text people already accepted: minor fix, or accept again?
              onClick={() => (active && value !== '' ? setAsking(true) : void save(false))}
            >
              {value === '' && active ? t('disclaimerAdmin.remove') : t('common.save')}
            </Button>
          )}
        </div>
      </Section>
    </List>
  );
}
