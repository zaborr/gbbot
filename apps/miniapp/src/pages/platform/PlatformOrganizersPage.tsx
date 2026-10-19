import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { OrganizersView } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PeopleField, peopleRefs, peopleText, personLabel } from '../../components/PeopleField.js';
import { ErrorBanner, useAdminActions } from '../admin/common.js';
import { t } from '../../i18n/index.js';

/** Platform super-admin: who may create GBs of their own. */
export function PlatformOrganizersPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <PlatformOrganizers />;
}

function PlatformOrganizers(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const view = useAsync(() => api.platformGetOrganizers(), [reloadKey]);
  if (view.loading && !view.data) return <Loader />;
  if (view.error) return <ErrorView message={view.error} />;
  if (!view.data) return <Loader />;
  return (
    <OrganizersForm
      view={view.data}
      onSaved={() => setReloadKey((k) => k + 1)}
    />
  );
}

function OrganizersForm({
  view,
  onSaved,
}: {
  view: OrganizersView;
  onSaved: () => void;
}): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [text, setText] = useState(peopleText(view.organizers, view.pendingUsernames));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const refs = peopleRefs(text);
  // Organisers taken off the list who own GBs: keep or take away those GBs?
  const kept = (p: OrganizersView['organizers'][number]): boolean =>
    (refs ?? []).some(
      (r) =>
        r === String(p.telegramId) ||
        (p.username !== null && r.replace(/^@/, '').toLowerCase() === p.username.toLowerCase()),
    );
  const removedOwners = refs === null ? [] : view.organizers.filter((p) => p.ownedShops > 0 && !kept(p));
  const [asking, setAsking] = useState(false);

  const save = async (releaseShops: boolean): Promise<void> => {
    if (refs === null) return;
    setBusy(true);
    setSaved(false);
    await actions.run(async () => {
      await api.platformUpdateOrganizers(refs, releaseShops);
      setSaved(true);
      setAsking(false);
      onSaved();
    });
    setBusy(false);
  };

  return (
    <List>
      <ErrorBanner message={actions.error} />
      <Section header={t('organizers.title')} footer={t('organizers.footer')}>
        <Cell multiline>{t('organizers.intro')}</Cell>
        <PeopleField
          header={t('organizers.field')}
          value={text}
          onChange={setText}
          people={view.organizers}
          pending={view.pendingUsernames}
        />
      </Section>
      <Section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          {asking ? (
            <>
              <Cell multiline>
                {t('organizers.removeOwners', {
                  names: removedOwners.map((p) => personLabel(p)).join(', '),
                  count: removedOwners.reduce((n, p) => n + p.ownedShops, 0),
                })}
              </Cell>
              <Button stretched loading={busy} onClick={() => void save(true)}>
                {t('organizers.releaseShops')}
              </Button>
              <Button stretched mode="bezeled" loading={busy} onClick={() => void save(false)}>
                {t('organizers.keepShops')}
              </Button>
              <Button stretched mode="plain" onClick={() => setAsking(false)}>
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <Button
              stretched
              loading={busy}
              disabled={refs === null}
              onClick={() => (removedOwners.length > 0 ? setAsking(true) : void save(false))}
            >
              {t('common.save')}
            </Button>
          )}
          {saved && <Cell>{t('common.saved')}</Cell>}
        </div>
      </Section>
    </List>
  );
}
