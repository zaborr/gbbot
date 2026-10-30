import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageTitle } from '../../components/PageTitle.js';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { ShopTeam } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { DeleteShopSection } from '../../components/DeleteShopSection.js';
import { PeopleField, peopleRefs, peopleText } from '../../components/PeopleField.js';
import { ErrorBanner, useAdminActions } from './common.js';
import { Input } from '../../components/Field.js';
import { toSlug } from '../../lib/slug.js';
import { shopPath } from '../../providers/ShopProvider.js';
import { t } from '../../i18n/index.js';
import { isWebMode, saveBase64File } from '../../lib/web.js';

/** The GB's administrators: who runs it, who sees it, copies and deleting it. */
export function AdminOwnerPage(): React.JSX.Element {
  const { shop } = useShop();
  if (!shop.canOwn) return <ErrorView message={t('owner.only')} />;
  return <AdminOwner />;
}

function AdminOwner(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const team = useAsync(() => api.adminGetTeam(), [reloadKey]);
  if (team.loading && !team.data) return <Loader />;
  if (team.error) return <ErrorView message={team.error} />;
  if (!team.data) return <Loader />;
  return <OwnerForm team={team.data} onSaved={() => setReloadKey((k) => k + 1)} />;
}

function OwnerForm({ team, onSaved }: { team: ShopTeam; onSaved: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const { shop, reload } = useShop();
  const actions = useAdminActions(() => undefined);
  const [visibility, setVisibility] = useState<'visible' | 'vip' | 'guests' | 'hidden'>(
    !shop.isVisible ? 'hidden' : shop.vipOnly ? (shop.allowGuests ? 'guests' : 'vip') : 'visible',
  );
  const [owners, setOwners] = useState(peopleText(team.owners, team.pendingOwnerUsernames));
  const [admins, setAdmins] = useState(peopleText(team.admins, team.pendingUsernames));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const ownerRefs = peopleRefs(owners);
  const refs = peopleRefs(admins);
  // Never without administrators (a super-admin may leave it to the platform).
  const { isSuperAdmin } = useSession();
  const ownersInvalid = ownerRefs === null || (ownerRefs.length === 0 && !isSuperAdmin);
  // The menu opens one part at a time (?section=team|duplicate|backup|delete).
  const [params] = useSearchParams();
  const section = params.get('section');
  const show = (part: string): boolean => section === null || section === part;
  const titles: Record<string, string> = {
    team: t('adminHome.ownerTeam'),
    duplicate: t('adminHome.duplicate'),
    backup: t('adminHome.backup'),
    delete: t('adminHome.ownerDelete'),
  };

  const save = async (): Promise<void> => {
    if (refs === null || ownerRefs === null || ownersInvalid) return;
    setBusy(true);
    setSaved(false);
    await actions.run(async () => {
      await api.adminUpdateOwnerSettings({
        isVisible: visibility !== 'hidden',
        vipOnly: visibility === 'vip' || visibility === 'guests',
        allowGuests: visibility === 'guests',
        owners: ownerRefs,
        admins: refs,
      });
      setSaved(true);
      onSaved();
      reload();
    });
    setBusy(false);
  };

  return (
    <List>
      <PageTitle title={(section && titles[section]) || t('adminHome.owner')} />
      <ErrorBanner message={actions.error} />

      {show('team') && (
      <>
      <Section header={t('settings.visibility')} footer={t('platformShop.visibilityFooter')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 16px 0' }}>
          {(
            [
              ['visible', t('settings.visible')],
              ['vip', t('platformShop.vipOnly')],
              ['guests', t('platformShop.vipGuests')],
              ['hidden', t('platformShop.hidden')],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="s"
              mode={visibility === value ? 'filled' : 'bezeled'}
              onClick={() => setVisibility(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Cell multiline>
          {visibility === 'visible'
            ? t('platformShop.customersSee')
            : visibility === 'vip'
              ? t('platformShop.onlyVip')
              : visibility === 'guests'
                ? t('platformShop.onlyVipGuests')
                : t('platformShop.onlyAdmins')}
        </Cell>
      </Section>

      <Section header={t('platformShop.owner')} footer={t('owner.ownersFooter')}>
        <PeopleField
          header={ownersInvalid ? t('owner.ownersRequired') : t('platformShop.ownerField')}
          value={owners}
          onChange={setOwners}
          people={team.owners}
          pending={team.pendingOwnerUsernames}
        />
      </Section>

      <Section header={t('platformShop.admins')} footer={t('owner.adminsFooter')}>
        <PeopleField
          header={t('platformShop.adminsField')}
          value={admins}
          onChange={setAdmins}
          people={team.admins}
          pending={team.pendingUsernames}
        />
      </Section>

      <Section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Button stretched loading={busy} disabled={refs === null || ownersInvalid} onClick={() => void save()}>
            {t('common.save')}
          </Button>
          {saved && <Cell>{t('common.saved')}</Cell>}
        </div>
      </Section>
      </>
      )}

      {show('duplicate') && <DuplicateSection name={shop.name} />}

      {show('backup') && <BackupSection />}

      {show('delete') && (
        <DeleteShopSection
          shop={shop}
          loadContents={() => api.adminShopContents()}
          deleteAll={(confirmName) => api.adminDeleteShopWithEverything(confirmName)}
          onDeleted={() => navigate('/', { replace: true })}
        />
      )}
    </List>
  );
}

/** A new, hidden GB with this one's settings and catalog: for the next round. */
function DuplicateSection({ name }: { name: string }): React.JSX.Element {
  const navigate = useNavigate();
  const actions = useAdminActions(() => undefined);
  const [copyName, setCopyName] = useState(t('duplicate.defaultName', { name }));
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const slugValue = slug.trim() || toSlug(copyName);

  const duplicate = async (): Promise<void> => {
    setBusy(true);
    await actions.run(async () => {
      const copy = await api.adminDuplicateShop(copyName.trim(), slugValue);
      navigate(shopPath(copy.slug, '/admin'));
    });
    setBusy(false);
  };

  return (
    <>
      <ErrorBanner message={actions.error} />
      <Section header={t('duplicate.title')} footer={t('duplicate.footer')}>
        <Input header={t('settings.name')} value={copyName} onChange={(e) => setCopyName(e.target.value)} />
        <Input
          header={t('platformShop.slug')}
          placeholder={toSlug(copyName) || 'tea-shop'}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            loading={busy}
            disabled={!copyName.trim() || !slugValue}
            onClick={() => void duplicate()}
          >
            {t('duplicate.button')}
          </Button>
        </div>
      </Section>
    </>
  );
}

/** The bot sends a JSON backup (settings and catalog, no orders). */
function BackupSection(): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <>
      <ErrorBanner message={actions.error} />
      <Section
        header={t('backup.title')}
        footer={t(isWebMode() ? 'backup.footerWeb' : 'backup.footer')}
      >
        <div style={{ padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void actions
                .run(async () => {
                  const result = await api.adminBackupShop();
                  if (result.file) saveBase64File(result.file);
                  setSent(true);
                })
                .finally(() => setBusy(false));
            }}
          >
            {t(isWebMode() ? 'backup.sendWeb' : 'backup.send')}
          </Button>
        </div>
        {sent && <Cell multiline>{t(isWebMode() ? 'web.fileSaved' : 'csv.sent')}</Cell>}
      </Section>
    </>
  );
}
