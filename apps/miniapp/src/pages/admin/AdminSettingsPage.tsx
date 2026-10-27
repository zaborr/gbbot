import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input, Textarea } from '../../components/Field.js';
import type { ShopAdminView } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useShop } from '../../providers/ShopProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { ProductImage } from '../../components/ProductImage.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { LangTabs, type TextLang } from '../../components/LangTabs.js';
import { t } from '../../i18n/index.js';

/** Shop name, description and image, editable by the shop's own admins. */
export function AdminSettingsPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminSettings />
    </AdminOnly>
  );
}

function AdminSettings(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const view = useAsync(() => api.adminGetShop(), [reloadKey]);

  if (view.loading && !view.data) return <Loader />;
  if (view.error) return <ErrorView message={view.error} />;
  if (!view.data) return <Loader />;

  return (
    <List>
      <PageTitle title={t('adminHome.profile')} />
      <ProfileForm
        key={`${view.data.name}|${view.data.description}|${view.data.imageUrl ?? ''}`}
        view={view.data}
        onSaved={() => setReloadKey((k) => k + 1)}
      />
    </List>
  );
}

function ProfileForm({
  view,
  onSaved,
}: {
  view: ShopAdminView;
  onSaved: () => void;
}): React.JSX.Element {
  const { reload, shop } = useShop();
  const actions = useAdminActions(() => {
    onSaved();
    reload();
  });
  const [name, setName] = useState(view.name);
  const [description, setDescription] = useState(view.description);
  const [nameEn, setNameEn] = useState(view.nameEn ?? '');
  const [descriptionEn, setDescriptionEn] = useState(view.descriptionEn ?? '');
  const [textLang, setTextLang] = useState<TextLang>('es');
  const [imageUrl, setImageUrl] = useState(view.imageUrl ?? '');
  const [busy, setBusy] = useState(false);

  const image = imageUrl.trim();
  const imageInvalid = image !== '' && !/^https:\/\/\S+$/i.test(image);
  const unchanged =
    name.trim() === view.name &&
    description.trim() === view.description &&
    (nameEn.trim() || null) === view.nameEn &&
    (descriptionEn.trim() || null) === view.descriptionEn &&
    (image || null) === view.imageUrl;

  const save = async (): Promise<void> => {
    setBusy(true);
    await actions.run(() =>
      api.adminUpdateProfile({
        name: name.trim(),
        description: description.trim(),
        nameEn: nameEn.trim() || null,
        descriptionEn: descriptionEn.trim() || null,
        imageUrl: image === '' ? null : image,
      }),
    );
    setBusy(false);
  };

  return (
    <>
      <ErrorBanner message={actions.error} />
      <Section header={t('settings.profile')} footer={t('settings.profileFooter')}>
        <LangTabs value={textLang} onChange={setTextLang} englishDone={nameEn.trim() !== ''} />
        {textLang === 'es' ? (
          <>
            <Input header={t('settings.name')} value={name} onChange={(e) => setName(e.target.value)} />
            <Textarea
              header={t('productForm.description')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </>
        ) : (
          <>
            <Input
              header={t('settings.name')}
              placeholder={name}
              value={nameEn}
              onChange={(e) => setNameEn(e.target.value)}
            />
            <Textarea
              header={t('productForm.description')}
              placeholder={description}
              value={descriptionEn}
              onChange={(e) => setDescriptionEn(e.target.value)}
            />
          </>
        )}
        <Input
          header={imageInvalid ? t('common.imageInvalid') : t('settings.image')}
          type="url"
          placeholder="https://…/logo.png"
          status={imageInvalid ? 'error' : 'default'}
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
        />
        {image !== '' && !imageInvalid && (
          <div style={{ padding: '8px 16px' }}>
            <ProductImage url={image} alt={t('common.preview')} size={96} />
          </div>
        )}
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={!name.trim() || imageInvalid || unchanged}
            onClick={() => void save()}
          >
            {t('settings.saveProfile')}
          </Button>
        </div>
      </Section>

      {/* Read only, for managers: administrators change it in their own section. */}
      {!shop.canOwn && (
        <Section
          header={t('settings.access')}
          footer={t('settings.accessFooter')}
        >
          <Cell after={`/${view.slug}`}>{t('settings.linkName')}</Cell>
          <Cell
            after={
              !view.isVisible
                ? t('shops.hidden')
                : view.vipOnly
                  ? t('platformShop.vipOnly')
                  : t('settings.visible')
            }
          >
            {t('settings.visibility')}
          </Cell>
          <Cell
            after={
              [...view.ownerIds.map(String), ...view.ownerUsernames.map((u) => `@${u} ⏳`)].join(', ') ||
              '—'
            }
            multiline
          >
            {t('platformShop.owner')}
          </Cell>
          <Cell
            after={
              [...view.adminIds.map(String), ...view.adminUsernames.map((u) => `@${u} ⏳`)].join(', ') ||
              '—'
            }
            multiline
          >
            {t('platformShop.admins')}
          </Cell>
        </Section>
      )}
    </>
  );
}

/** How long an unpaid order waits before it is cancelled automatically. */
export function AutoCancelForm({
  view,
  onSaved,
}: {
  view: ShopAdminView;
  onSaved: () => void;
}): React.JSX.Element {
  const actions = useAdminActions(onSaved);
  const [hours, setHours] = useState(String(view.autoCancelHours));
  const value = Number(hours.trim());
  const invalid = hours.trim() === '' || !Number.isInteger(value) || value < 0 || value > 720;

  return (
    <>
      <ErrorBanner message={actions.error} />
      <Section
        header={t('settings.unpaid')}
        footer={t('settings.unpaidFooter')}
      >
        <Input
          header={t('settings.unpaidHours')}
          inputMode="numeric"
          status={invalid ? 'error' : 'default'}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            disabled={invalid || value === view.autoCancelHours}
            onClick={() => void actions.run(() => api.adminUpdateAutoCancel(value))}
          >
            {t('common.save')}
          </Button>
        </div>
      </Section>
    </>
  );
}
