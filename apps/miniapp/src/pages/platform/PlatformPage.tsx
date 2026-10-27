import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ShopAdminView } from '@tma-shop/shared';
import { Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { shopPath } from '../../providers/ShopProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { ProductImage } from '../../components/ProductImage.js';
import { t, tn } from '../../i18n/index.js';

/** Platform super-admin: every shop, hidden ones included. */
export function PlatformPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <Platform />;
}

function Platform(): React.JSX.Element {
  const navigate = useNavigate();
  const { webRole } = useSession();
  const shops = useAsync(() => api.platformGetShops(), []);
  // The list after moving GBs around (no reload, no flicker).
  const [ordered, setOrdered] = useState<ShopAdminView[] | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  if (shops.loading && !shops.data) return <Loader />;
  if (shops.error) return <ErrorView message={shops.error} />;
  const list = ordered ?? shops.data ?? [];

  const move = async (shopId: string, direction: 'up' | 'down'): Promise<void> => {
    setMoving(shopId);
    try {
      setOrdered(await api.platformMoveShop(shopId, direction));
    } finally {
      setMoving(null);
    }
  };
  const arrow: React.CSSProperties = {
    minWidth: 36,
    padding: '4px 8px',
    border: 'none',
    borderRadius: 8,
    background: 'var(--tgui--secondary_fill)',
    color: 'var(--tgui--link_color)',
    fontSize: 16,
    cursor: 'pointer',
  };

  return (
    <List>
      <Section>
        <Cell onClick={() => navigate('/platform/shops/new')}>{t('platform.newShop')}</Cell>
        <Cell onClick={() => navigate('/import-gb')}>{t('shops.importGb')}</Cell>
        <Cell onClick={() => navigate('/platform/organizers')}>{t('platform.organizers')}</Cell>
        <Cell onClick={() => navigate('/platform/vip')}>{t('platform.vipClub')}</Cell>
        <Cell onClick={() => navigate('/platform/blacklist')}>{t('platform.blacklist')}</Cell>
        <Cell onClick={() => navigate('/platform/retention')}>{t('platform.retention')}</Cell>
        {webRole === 'platform' && (
          <Cell onClick={() => navigate('/platform/web-accounts')}>{t('platform.webAccounts')}</Cell>
        )}
      </Section>

      {list.length === 0 ? (
        <Placeholder header={t('shops.empty')} description={t('platform.createFirst')}>
          <span style={{ fontSize: 48 }}>🏪</span>
        </Placeholder>
      ) : (
        <Section
          header={t('platform.allShops', { count: list.length })}
          footer={t('platform.footer')}
        >
          {list.map((shop, index) => (
            <Cell
              key={shop.id}
              onClick={() => navigate(shopPath(shop.slug, '/admin'))}
              before={shop.imageUrl ? <ProductImage url={shop.imageUrl} alt={shop.name} size={48} /> : undefined}
              subtitle={`/${shop.slug}`}
              description={
                <span className="gb-chips" style={{ marginTop: 4 }}>
                  <span
                    className={
                      !shop.isVisible
                        ? 'gb-chip'
                        : shop.vipOnly
                          ? 'gb-chip gb-chip--vip'
                          : 'gb-chip gb-chip--ok'
                    }
                  >
                    {!shop.isVisible
                      ? t('platform.hidden')
                      : shop.vipOnly
                        ? t('platform.vipOnly')
                        : t('platform.visible')}
                  </span>
                  {shop.paymentMethods.length + shop.manualMethods.length === 0 ? (
                    <span className="gb-chip gb-chip--warn">{t('platform.noPayment')}</span>
                  ) : null}
                  {/* No administrator: worth a look (soft orange), not an error. */}
                  <span
                    className={
                      shop.ownerIds.length + shop.ownerUsernames.length === 0
                        ? 'gb-chip gb-chip--soft'
                        : 'gb-chip'
                    }
                  >
                    {tn(
                      shop.ownerIds.length + shop.ownerUsernames.length,
                      'count.owners.one',
                      'count.owners.other',
                    )}
                  </span>
                </span>
              }
              after={
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    aria-label={t('platform.moveUp')}
                    style={{ ...arrow, opacity: index === 0 ? 0.3 : 1 }}
                    disabled={index === 0 || moving !== null}
                    onClick={(event) => {
                      event.stopPropagation();
                      void move(shop.id, 'up');
                    }}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label={t('platform.moveDown')}
                    style={{ ...arrow, opacity: index === list.length - 1 ? 0.3 : 1 }}
                    disabled={index === list.length - 1 || moving !== null}
                    onClick={(event) => {
                      event.stopPropagation();
                      void move(shop.id, 'down');
                    }}
                  >
                    ▼
                  </button>
                  <span
                    role="button"
                    style={{ color: 'var(--tgui--link_color)', marginLeft: 4 }}
                    onClick={(event) => {
                      event.stopPropagation();
                      navigate(shopPath(shop.slug));
                    }}
                  >
                    {t('platform.open')}
                  </span>
                </div>
              }
              multiline
            >
              {shop.name}
            </Cell>
          ))}
        </Section>
      )}
    </List>
  );
}
