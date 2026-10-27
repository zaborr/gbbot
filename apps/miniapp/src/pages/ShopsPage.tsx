import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { retrieveLaunchParams } from '@telegram-apps/sdk-react';
import { Button, Cell, List, Placeholder, Section, Title } from '@telegram-apps/telegram-ui';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { shopPath } from '../providers/ShopProvider.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { t, tn } from '../i18n/index.js';
import { LanguagePicker } from '../components/LanguagePicker.js';
import { isWebMode } from '../lib/web.js';
import { shopName } from '../lib/localize.js';
import { ShopCard } from '../components/ShopCard.js';
import { HowItWorks } from '../components/HowItWorks.js';

let startParamUsed = false;

const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a launch link points, returned only the first time:
 * `?startapp=<slug>` opens a shop; `?shop=<slug>&order=<id>` (the bot's
 * payment reminders) opens that order; `?upload=<id>` (a file sent to the
 * bot) opens its import screen.
 */
function takeStartPath(): string | null {
  if (startParamUsed) return null;
  startParamUsed = true;
  try {
    const query = new URLSearchParams(window.location.search);
    const shop = query.get('shop');
    const order = query.get('order');
    // A file sent to the bot: its "Open to import" button.
    const upload = query.get('upload');
    if (upload && UUID_RE.test(upload)) return `/upload/${upload}`;
    if (shop && order && SLUG_RE.test(shop) && UUID_RE.test(order)) {
      return shopPath(shop, `/orders/${order}`);
    }
    // `?shop=<slug>` alone: a message from the organiser ("Open the GB").
    if (shop && SLUG_RE.test(shop)) return shopPath(shop);
  } catch {
    // No usable query string.
  }
  try {
    const param = retrieveLaunchParams().tgWebAppStartParam;
    return typeof param === 'string' && SLUG_RE.test(param) ? shopPath(param) : null;
  } catch {
    return null;
  }
}

/** Start screen: the shops in this bot. */
export function ShopsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const result = useAsync(() => api.getShops(), []);

  // Links like t.me/<bot>/<app>?startapp=<shop-slug> open that shop directly,
  // and the bot's reminders open the order to pay.
  useEffect(() => {
    const path = takeStartPath();
    if (path) navigate(path);
  }, [navigate]);

  if (result.loading) return <Loader />;
  if (result.error) return <ErrorView message={result.error} />;
  const shops = result.data?.shops ?? [];
  const isSuperAdmin = result.data?.isSuperAdmin ?? false;
  const isOrganizer = result.data?.isOrganizer ?? false;

  return (
    <List>
      {shops.length === 0 ? (
        <Placeholder
          header={t('shops.empty')}
          description={isSuperAdmin ? t('shops.emptyAdmin') : t('shops.emptyCustomer')}
        >
          <span style={{ fontSize: 48 }}>🏪</span>
        </Placeholder>
      ) : (
        <>
          <div className="gb-intro">
            <Title level="2" weight="2">
              {t('shops.pick')}
            </Title>
            <span className="gb-hint">{t('shops.pickHint')}</span>
          </div>
          {/* Something to do first: orders still to pay. */}
          {shops
            .filter((shop) => shop.unpaidOrders > 0)
            .map((shop) => (
              <div key={`pay-${shop.id}`} className="gb-banner">
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <strong>{tn(shop.unpaidOrders, 'shops.toPay.one', 'shops.toPay.other')}</strong>
                  <span style={{ fontSize: 14 }}>{shopName(shop)}</span>
                </div>
                <Button size="s" onClick={() => navigate(shopPath(shop.slug, '/orders'))}>
                  {t('shops.pay')}
                </Button>
              </div>
            ))}
          {shops.map((shop) => (
            <ShopCard key={shop.id} shop={shop} onOpen={() => navigate(shopPath(shop.slug))} />
          ))}
          <div className="gb-hint" style={{ padding: '0 20px 12px', fontSize: 14 }}>
            {t('shops.footer')}
          </div>
        </>
      )}


      {isOrganizer && !isSuperAdmin && (
        <Section header={t('shops.organizer')} footer={t('shops.organizerFooter')}>
          <Cell onClick={() => navigate('/new-gb')}>{t('shops.createGb')}</Cell>
          <Cell onClick={() => navigate('/import-gb')}>{t('shops.importGb')}</Cell>
        </Section>
      )}

      {isWebMode() && (
        <Section header={t('webPassword.section')}>
          <Cell onClick={() => navigate('/web-password')}>{t('webPassword.title')}</Cell>
        </Section>
      )}

      {result.data?.canUseWeb && !isWebMode() && (
        <Section>
          <Cell onClick={() => navigate('/web-access')} subtitle={t('webAccess.hint')}>
            {t('webAccess.title')}
          </Cell>
        </Section>
      )}

      {isSuperAdmin && (
        <Section header={t('shops.platform')}>
          <Cell onClick={() => navigate('/platform')} subtitle={t('shops.platformHint')}>
            {t('shops.platformAdmin')}
          </Cell>
        </Section>
      )}
      <LanguagePicker />
      {!isWebMode() && shops.length > 0 && <HowItWorks />}
    </List>
  );
}
