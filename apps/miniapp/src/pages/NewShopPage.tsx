import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Input, Textarea } from '../components/Field.js';
import { api } from '../api/client.js';
import { toSlug } from '../lib/slug.js';
import { shopPath } from '../providers/ShopProvider.js';
import { ErrorBanner, useAdminActions } from './admin/common.js';
import { t } from '../i18n/index.js';

/** An organiser creates a GB of their own: it starts hidden, with them as owner and admin. */
export function NewShopPage(): React.JSX.Element {
  const navigate = useNavigate();
  const actions = useAdminActions(() => undefined);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const slugValue = slug.trim() || toSlug(name);

  const create = async (): Promise<void> => {
    setBusy(true);
    await actions.run(async () => {
      const shop = await api.organizerCreateShop({
        name: name.trim(),
        slug: slugValue,
        description: description.trim(),
        nameEn: null,
        descriptionEn: null,
        imageUrl: null,
      });
      navigate(shopPath(shop.slug, '/admin'), { replace: true });
    });
    setBusy(false);
  };

  return (
    <List>
      <ErrorBanner message={actions.error} />
      <Section header={t('newGb.title')} footer={t('newGb.footer')}>
        <Input header={t('settings.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          header={t('platformShop.slug')}
          placeholder={name ? toSlug(name) : 'tea-shop'}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <Textarea
          header={t('productForm.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Cell multiline>{t('newGb.hidden')}</Cell>
      </Section>
      <Section>
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={!name.trim() || !slugValue}
            onClick={() => void create()}
          >
            {t('platformShop.create')}
          </Button>
        </div>
      </Section>
    </List>
  );
}
