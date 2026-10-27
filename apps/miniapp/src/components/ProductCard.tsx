import { useNavigate } from 'react-router-dom';
import { Cell } from '@telegram-apps/telegram-ui';
import type { Product } from '@tma-shop/shared';
import { formatPrice } from '../lib/format.js';
import { productDescription, productTitle } from '../lib/localize.js';
import { ProductImage } from './ProductImage.js';
import { hasVipPrice, isSoldOut, priceRange } from '../lib/variants.js';
import { useShop, useShopPath } from '../providers/ShopProvider.js';
import { t } from '../i18n/index.js';
import { useCart } from '../providers/CartProvider.js';

export function ProductCard({ product }: { product: Product }): React.JSX.Element {
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

  return (
    <Cell
      onClick={() => navigate(to(`/product/${product.id}`))}
      before={product.imageUrl ? <ProductImage url={product.imageUrl} alt={productTitle(product)} size={56} /> : undefined}
      subtitle={productDescription(product)}
      after={
        inCart > 0 ? (
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <span>{price}</span>
            <span className="gb-chip gb-chip--info">{t('catalog.inCart', { count: inCart })}</span>
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
