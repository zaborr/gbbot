import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input, Textarea } from '../../components/Field.js';
import type { PlatformShopInput, ShopAdminView, ShopTeam } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { toSlug } from '../../lib/slug.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { ProductImage } from '../../components/ProductImage.js';
import { DeleteShopSection } from '../../components/DeleteShopSection.js';
import { PeopleField, peopleRefs, peopleText } from '../../components/PeopleField.js';
import { ErrorBanner, useAdminActions } from '../admin/common.js';
import { LangTabs, type TextLang } from '../../components/LangTabs.js';
import { t } from '../../i18n/index.js';

/** `/platform/shops/new` creates a shop; `/platform/shops/:id` edits one. */
export function PlatformShopPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <PlatformShop />;
}

const NO_TEAM: ShopTeam = { owners: [], admins: [], pendingOwnerUsernames: [], pendingUsernames: [] };

function PlatformShop(): React.JSX.Element {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const [reloadKey, setReloadKey] = useState(0);
  const data = useAsync(async (): Promise<{ shop: ShopAdminView | null; team: ShopTeam }> => {
    if (isNew) return { shop: null, team: NO_TEAM };
    const [shops, team] = await Promise.all([api.platformGetShops(), api.platformGetTeam(id)]);
    return { shop: shops.find((s) => s.id === id) ?? null, team };
  }, [id, reloadKey]);

  if (data.loading && !data.data) return <Loader />;
  if (data.error) return <ErrorView message={data.error} />;
  if (!data.data) return <Loader />;
  const { shop, team } = data.data;
  if (!isNew && !shop) return <ErrorView message={t('platformShop.notFound')} />;

  return (
    <ShopForm
      key={shop?.id ?? 'new'}
      shop={shop}
      team={team}
      onSaved={() => setReloadKey((k) => k + 1)}
    />
  );
}

function ShopForm({
  shop,
  team,
  onSaved,
}: {
  shop: ShopAdminView | null;
  team: ShopTeam;
  onSaved: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { user } = useSession();
  const actions = useAdminActions(() => undefined);

  const [name, setName] = useState(shop?.name ?? '');
  const [slug, setSlug] = useState(shop?.slug ?? '');
  const [description, setDescription] = useState(shop?.description ?? '');
  const [nameEn, setNameEn] = useState(shop?.nameEn ?? '');
  const [descriptionEn, setDescriptionEn] = useState(shop?.descriptionEn ?? '');
  const [textLang, setTextLang] = useState<TextLang>('es');
  const [imageUrl, setImageUrl] = useState(shop?.imageUrl ?? '');
  const [visibility, setVisibility] = useState<'visible' | 'vip' | 'guests' | 'hidden'>(
    !shop || !shop.isVisible ? 'hidden' : shop.vipOnly ? (shop.allowGuests ? 'guests' : 'vip') : 'visible',
  );
  // Order is changed with the arrows in Platform; kept as it is here.
  const sortOrder = String(shop?.sortOrder ?? 0);
  const [admins, setAdmins] = useState(
    shop ? peopleText(team.admins, team.pendingUsernames) : user ? String(user.telegramId) : '',
  );
  const [owners, setOwners] = useState(peopleText(team.owners, team.pendingOwnerUsernames));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const slugValue = slug.trim() || toSlug(name);
  const image = imageUrl.trim();
  const imageInvalid = image !== '' && !/^https:\/\/\S+$/i.test(image);
  const adminRefs = peopleRefs(admins);
  const ownerRefs = peopleRefs(owners);
  const order = Number(sortOrder);
  const invalid = !name.trim() || imageInvalid || adminRefs === null || ownerRefs === null;

  const save = async (): Promise<void> => {
    if (adminRefs === null || ownerRefs === null) return;
    const input: PlatformShopInput = {
      name: name.trim(),
      slug: slugValue,
      description: description.trim(),
      nameEn: nameEn.trim() || null,
      descriptionEn: descriptionEn.trim() || null,
      imageUrl: image === '' ? null : image,
      isVisible: visibility !== 'hidden',
      vipOnly: visibility === 'vip' || visibility === 'guests',
      allowGuests: visibility === 'guests',
      sortOrder: order,
      admins: adminRefs,
      owners: ownerRefs,
    };
    setBusy(true);
    setSaved(false);
    await actions.run(async () => {
      if (shop) {
        await api.platformUpdateShop(shop.id, input);
        setSaved(true);
        onSaved();
      } else {
        await api.platformCreateShop(input);
        navigate('/platform', { replace: true });
      }
    });
    setBusy(false);
  };

  return (
    <List>
      <ErrorBanner message={actions.error} />

      <Section header={shop ? t('platformShop.edit', { name: shop.name }) : t('platformShop.new')}>
        <LangTabs value={textLang} onChange={setTextLang} englishDone={nameEn.trim() !== ''} />
        {textLang === 'es' ? (
          <Input header={t('settings.name')} value={name} onChange={(e) => setName(e.target.value)} />
        ) : (
          <Input
            header={t('settings.name')}
            placeholder={name}
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
          />
        )}
        <Input
          header={t('platformShop.slug')}
          placeholder={name ? toSlug(name) : 'tea-shop'}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        {textLang === 'es' ? (
          <Textarea
            header={t('productForm.description')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        ) : (
          <Textarea
            header={t('productForm.description')}
            placeholder={description}
            value={descriptionEn}
            onChange={(e) => setDescriptionEn(e.target.value)}
          />
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
      </Section>

      <Section
        header={t('settings.visibility')}
        footer={t('platformShop.visibilityFooter')}
      >
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

      <Section header={t('platformShop.owner')} footer={t('platformShop.ownerFooter')}>
        <PeopleField
          header={t('platformShop.ownerField')}
          value={owners}
          onChange={setOwners}
          people={team.owners}
          pending={team.pendingOwnerUsernames}
        />
      </Section>

      <Section header={t('platformShop.admins')} footer={t('platformShop.adminsFooter')}>
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
          <Button stretched loading={busy} disabled={invalid} onClick={() => void save()}>
            {shop ? t('platformShop.save') : t('platformShop.create')}
          </Button>
          {saved && <Cell>{t('common.saved')}</Cell>}
        </div>
      </Section>

      {shop && (
        <DeleteShopSection
          shop={shop}
          loadContents={() => api.platformShopContents(shop.id)}
          deleteAll={(confirmName) => api.platformDeleteShopWithEverything(shop.id, confirmName)}
          onDeleted={() => navigate('/platform', { replace: true })}
        />
      )}
    </List>
  );
}
