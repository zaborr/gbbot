import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { SupervisorsView } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PeopleField, peopleRefs, peopleText } from '../../components/PeopleField.js';
import { ErrorBanner, useAdminActions } from '../admin/common.js';
import { t } from '../../i18n/index.js';

/** Platform super-admin: who is an administrator of every GB. */
export function PlatformSupervisorsPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <PlatformSupervisors />;
}

function PlatformSupervisors(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const view = useAsync(() => api.platformGetSupervisors(), [reloadKey]);
  if (view.loading && !view.data) return <Loader />;
  if (view.error) return <ErrorView message={view.error} />;
  if (!view.data) return <Loader />;
  return <SupervisorsForm view={view.data} onSaved={() => setReloadKey((k) => k + 1)} />;
}

function SupervisorsForm({ view, onSaved }: { view: SupervisorsView; onSaved: () => void }): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [text, setText] = useState(peopleText(view.supervisors, view.pendingUsernames));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const refs = peopleRefs(text);

  const save = async (): Promise<void> => {
    if (refs === null) return;
    setBusy(true);
    setSaved(false);
    await actions.run(async () => {
      await api.platformUpdateSupervisors(refs);
      setSaved(true);
      onSaved();
    });
    setBusy(false);
  };

  return (
    <List>
      <Section header={t('supervisors.title')} footer={t('supervisors.footer')}>
        <Cell multiline>{t('supervisors.intro')}</Cell>
        <PeopleField
          header={t('supervisors.field')}
          value={text}
          onChange={(value) => {
            setText(value);
            setSaved(false);
          }}
          people={view.supervisors}
          pending={view.pendingUsernames}
        />
      </Section>
      <Section>
        <ErrorBanner message={actions.error} />
        <div style={{ padding: 16 }}>
          <Button stretched loading={busy} disabled={refs === null} onClick={() => void save()}>
            {saved ? t('common.saved') : t('common.save')}
          </Button>
        </div>
      </Section>
    </List>
  );
}
