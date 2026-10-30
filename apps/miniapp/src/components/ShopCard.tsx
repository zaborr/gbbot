import { useState } from 'react';
import { Button } from '@telegram-apps/telegram-ui';
import type { ShopSummary } from '@tma-shop/shared';
import { OrganizedBy } from './OrganizedBy.js';
import { GoalBar } from './GoalBar.js';
import { closingDate } from './ClosingNotice.js';
import { shopDescription, shopName } from '../lib/localize.js';
import { t, tn } from '../i18n/index.js';

/**
 * One GB on the start screen: a card with its picture, name, who runs it, its
 * state as labels, the minimum's progress and a clear "See products" button
 * (the whole card opens it too). A closed GB leads its customers to their orders.
 */
export function ShopCard({
  shop,
  onOpen,
}: {
  shop: ShopSummary;
  onOpen: () => void;
}): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);
  const description = shopDescription(shop);
  const chips: Array<{ text: string; kind: string }> = [
    shop.unpaidOrders > 0
      ? { text: tn(shop.unpaidOrders, 'shops.unpaid.one', 'shops.unpaid.other'), kind: 'warn' }
      : null,
    shop.cartItems > 0 ? { text: t('shops.inCart', { count: shop.cartItems }), kind: 'info' } : null,
    shop.isClosed
      ? { text: t('shops.closed'), kind: '' }
      : shop.closesAt
        ? { text: t('shops.closes', { date: closingDate(shop.closesAt) }), kind: 'warn' }
        : null,
    shop.isVisible ? null : { text: t('shops.hidden'), kind: '' },
    shop.isVisible && shop.vipOnly
      ? {
          // A guest is let in, but is not a VIP.
          text: shop.isVip || !shop.allowGuests ? t('shops.vip') : t(shop.canManage ? 'shops.vipGuests' : 'shops.guest'),
          kind: 'vip',
        }
      : null,
    shop.canManage ? { text: t('shops.youManage'), kind: 'info' } : null,
  ].filter((c): c is { text: string; kind: string } => c !== null);

  return (
    <div className="gb-card" onClick={onOpen} style={{ cursor: 'pointer' }}>
      {shop.imageUrl && !imageFailed && (
        <img
          className="gb-card-image"
          src={shop.imageUrl}
          alt={shopName(shop)}
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      )}
      <div className="gb-card-body">
        <div style={{ fontSize: 19, fontWeight: 700, lineHeight: '24px' }}>{shopName(shop)}</div>
        {shop.organizers.length > 0 && (
          <div className="gb-hint" style={{ fontSize: 14 }}>
            <OrganizedBy organizers={shop.organizers} />
          </div>
        )}
        {description && <div className="gb-hint">{description}</div>}
        {chips.length > 0 && (
          <div className="gb-chips">
            {chips.map((chip) => (
              <span key={chip.text} className={chip.kind ? `gb-chip gb-chip--${chip.kind}` : 'gb-chip'}>
                {chip.text}
              </span>
            ))}
          </div>
        )}
        {shop.goal && <GoalBar goal={shop.goal} compact />}
        <div style={{ marginTop: 4 }}>
          <Button
            stretched
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            {shop.isClosed && !shop.canManage ? t('shops.seeOrders') : t('shops.seeProducts')}
          </Button>
        </div>
      </div>
    </div>
  );
}
