import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, List, Section, Text, Title } from '@telegram-apps/telegram-ui';
import type { ShopConfig } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { ProductImage } from './ProductImage.js';
import { shopName } from '../lib/localize.js';
import { t } from '../i18n/index.js';

/**
 * The GB's conditions, before anything else of it: the customer accepts them
 * once (and again when the organiser asks). Until then the API refuses the
 * catalog, cart and orders too.
 */
export function DisclaimerGate({
  shop,
  onAccepted,
}: {
  shop: ShopConfig;
  onAccepted: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disclaimer = shop.disclaimer;
  if (!disclaimer) return <></>;

  const accept = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.acceptDisclaimer(disclaimer.version);
      onAccepted();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('error.tryAgain'));
      // The text may have changed meanwhile: show the new one.
      onAccepted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <List>
      <Section>
        <div style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
          <ProductImage url={shop.imageUrl} alt={shopName(shop)} size={48} />
          <Title level="2" weight="2">
            {shopName(shop)}
          </Title>
        </div>
      </Section>
      <Section header={t('disclaimer.title')} footer={t('disclaimer.footer')}>
        <div style={{ padding: 16 }}>
          <Text style={{ whiteSpace: 'pre-wrap', display: 'block' }}>{disclaimer.text}</Text>
        </div>
      </Section>
      <Section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Button stretched loading={busy} onClick={() => void accept()}>
            {t('disclaimer.accept')}
          </Button>
          <Button stretched mode="plain" onClick={() => navigate('/')}>
            {t('disclaimer.decline')}
          </Button>
          {error && <Text style={{ color: 'var(--tgui--destructive_text_color)' }}>{error}</Text>}
        </div>
      </Section>
    </List>
  );
}
