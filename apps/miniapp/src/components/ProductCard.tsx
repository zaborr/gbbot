import { useNavigate } from 'react-router-dom';
import { Cell } from '@telegram-apps/telegram-ui';
import type { Product, Testing } from '@tma-shop/shared';
import { formatPrice } from '../lib/format.js';
import { productDescription, productTitle } from '../lib/localize.js';
import { ProductImage } from './ProductImage.js';
import { hasVipPrice, isSoldOut, priceRange } from '../lib/variants.js';
import { useShop, useShopPath } from '../providers/ShopProvider.js';
import { t } from '../i18n/index.js';
import { useCart } from '../providers/CartProvider.js';
import { productTestingState, sharePercent } from '../lib/testingState.js';

export function ProductCard({
  product,
  testings = [],
}: {
  product: Product;
  /** The GB's open testings (those of this product show as a label). */
  testings?: readonly Testing[];
}): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const outOfStock = isSoldOut(product);
  const vip = useShop().shop.isVip;
  const { min, max } = priceRange(product, vip);
  const amount =
    min === max
      ? formatPrice(min, product.currency)
      : t('product.from', { price: formatPrice(min, product.currency) });
  const price = hasVipPrice(product, vip) ? `⭐ ${amount}` : amount;
  // Already in the cart: said on the product, so the list shows what was chosen.
  const inCart = (useCart().cart?.lines ?? [])
    .filter((line) => line.product.id === product.id)
    .reduce((sum, line) => sum + line.quantity, 0);

  // Its open testing: a mark on the picture, and a line with where it stands.
  const testing = productTestingState(product.id, testings);
  const badge = testing ? (
    <span className={`gb-testing-badge gb-testing-badge--${testing.level}`} aria-hidden="true">
      {testing.level === 'hot' ? '🧪🔥' : testing.level === 'reached' ? '🧪✅' : '🧪'}
    </span>
  ) : null;
  const testingLine = testing
    ? [
        testing.reached.length > 0 ? `${testing.reached[testing.reached.length - 1]?.name ?? ''} ✅` : null,
        testing.next
          ? testing.next.unitsLeft !== null
            ? t('catalog.testingNext', { units: testing.next.unitsLeft, tier: testing.next.name })
            : t('catalog.testingNextShare', { percent: sharePercent(testing.next), tier: testing.next.name })
          : t('catalog.testingAll'),
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  const chips = [
    inCart > 0 ? (
      <span key="cart" className="gb-chip gb-chip--info">
        {t('catalog.inCart', { count: inCart })}
      </span>
    ) : null,
  ].filter(Boolean);

  return (
    <Cell
      onClick={() => navigate(to(`/product/${product.id}`))}
      before={
        product.imageUrl ? (
          <span className="gb-product-thumb">
            <ProductImage url={product.imageUrl} alt={productTitle(product)} size={56} />
            {badge}
          </span>
        ) : badge ? (
          <span className="gb-testing-badge-inline">{badge}</span>
        ) : undefined
      }
      subtitle={productDescription(product)}
      description={
        testingLine ? (
          <span className={`gb-testing-line gb-testing-line--${testing?.level ?? 'none'}`}>{testingLine}</span>
        ) : undefined
      }
      after={
        chips.length > 0 ? (
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <span>{price}</span>
            {chips}
          </span>
        ) : (
          price
        )
      }
      hint={outOfStock ? t('product.outOfStock') : product.vipOnly ? t('product.vipOnly') : undefined}
      multiline
    >
      {productTitle(product)}
    </Cell>
  );
}
