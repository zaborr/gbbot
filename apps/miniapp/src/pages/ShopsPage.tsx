import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { retrieveLaunchParams } from '@telegram-apps/sdk-react';
import { Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { shopPath } from '../providers/ShopProvider.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { ProductImage } from '../components/ProductImage.js';
import { t, tn } from '../i18n/index.js';
import { LanguagePicker } from '../components/LanguagePicker.js';
import { isWebMode } from '../lib/web.js';
import { closingDate } from '../components/ClosingNotice.js';
import { shopDescription, shopName } from '../lib/localize.js';
import { OrganizedBy } from '../components/OrganizedBy.js';
import { GoalBar } from '../components/GoalBar.js';

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
        <Section header={t('shops.title')} footer={t('shops.footer')} className="tma-shop-list">
          {shops.map((shop) => {
            const status = [
              shop.unpaidOrders > 0
                ? tn(shop.unpaidOrders, 'shops.unpaid.one', 'shops.unpaid.other')
                : null,
              shop.cartItems > 0 ? t('shops.inCart', { count: shop.cartItems }) : null,
              shop.isClosed
                ? t('shops.closed')
                : shop.closesAt
                  ? t('shops.closes', { date: closingDate(shop.closesAt) })
                  : null,
              shop.isVisible ? null : t('shops.hidden'),
              shop.isVisible && shop.vipOnly ? t('shops.vip') : null,
              shop.canManage ? t('shops.youManage') : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
            <Cell
              key={shop.id}
              onClick={() => navigate(shopPath(shop.slug))}
              before={<ProductImage url={shop.imageUrl} alt={shopName(shop)} size={56} />}
              subtitle={shopDescription(shop) || undefined}
              description={
                status || shop.organizers.length > 0 || shop.goal ? (
                  <>
                    {status}
                    <OrganizedBy organizers={shop.organizers} />
                    {shop.goal && <GoalBar goal={shop.goal} compact />}
                  </>
                ) : undefined
              }
              multiline
            >
              {shopName(shop)}
            </Cell>
            );
          })}
        </Section>
      )}

      <LanguagePicker />

      {isOrganizer && !isSuperAdmin && (
        <Section header={t('shops.organizer')} footer={t('shops.organizerFooter')}>
          <Cell onClick={() => navigate('/new-gb')}>{t('shops.createGb')}</Cell>
          <Cell onClick={() => navigate('/import-gb')}>{t('shops.importGb')}</Cell>
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
    </List>
  );
}
