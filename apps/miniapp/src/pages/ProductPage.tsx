import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { hapticFeedback } from '@telegram-apps/sdk-react';
import { Button, Cell, List, Section, Text, Title } from '@telegram-apps/telegram-ui';
import { unitPriceFor, type Product } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useCart } from '../providers/CartProvider.js';
import { useMainButton } from '../hooks/useMainButton.js';
import { formatPrice } from '../lib/format.js';
import { convertedPrice, otherPayment } from '../lib/exchange.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import {
  findVariant,
  hasVariants,
  isSoldOut,
  isValueAvailable,
  hasVipPrice,
  priceRange,
  tierTable,
  vipPriceFor,
} from '../lib/variants.js';
import { ProductImage } from '../components/ProductImage.js';
import { useShop, useShopPath } from '../providers/ShopProvider.js';
import { productDescription, productTitle } from '../lib/localize.js';
import { t, tn } from '../i18n/index.js';

export function ProductPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { data: product, loading, error } = useAsync(() => api.getProduct(id), [id]);

  if (loading) return <Loader />;
  if (error || !product) return <ErrorView message={error ?? t('product.notFound')} />;
  return <ProductView key={product.id} product={product} />;
}

function ProductView({ product }: { product: Product }): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const { shop } = useShop();
  const { add, itemCount, cart } = useCart();
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // What was just added: shown here, so the customer can go on (another colour…).
  const [added, setAdded] = useState<string | null>(null);

  const withVariants = hasVariants(product);
  // Preselect values when an option has a single choice.
  const [selected, setSelected] = useState<Array<string | null>>(() =>
    product.options.map((o) => (o.values.length === 1 ? (o.values[0] ?? null) : null)),
  );
  const variant = withVariants ? findVariant(product, selected) : null;
  const missing = withVariants && !variant;

  const stock = withVariants ? (variant?.stock ?? null) : product.stock;
  const outOfStock = withVariants
    ? isSoldOut(product) || (variant !== null && variant.stock !== null && variant.stock <= 0)
    : product.stock !== null && product.stock <= 0;
  // How many to add: at most what is in stock (999 = the cart's limit).
  // Products sold from a minimum (without variants) start at it; with variants
  // the minimum counts all of them together, so each one starts at 1.
  const [quantity, setQuantity] = useState(() => (hasVariants(product) ? 1 : product.minQuantity));
  const maxQuantity = Math.max(1, Math.min(999, stock ?? 999));
  const qty = Math.min(quantity, maxQuantity);
  const vip = shop.isVip;
  const unitPrice = unitPriceFor(
    product.price,
    variant?.priceOverride ?? null,
    product.priceTiers,
    qty,
    vipPriceFor(product, variant, vip),
  );

  const { min, max } = priceRange(product, vip);
  // For information: the price in the other token, if the GB lets you pay with it.
  const other = otherPayment(shop, product.currency);
  const otherText = other
    ? variant
      ? convertedPrice(vipPriceFor(product, variant, vip) ?? variant.price, other)
      : min === max
        ? convertedPrice(min, other)
        : `${convertedPrice(min, other)} – ${convertedPrice(max, other)}`
    : null;
  const priceText = variant
    ? formatPrice(vipPriceFor(product, variant, vip) ?? variant.price, product.currency)
    : min === max
      ? formatPrice(min, product.currency)
      : `${formatPrice(min, product.currency)} – ${formatPrice(max, product.currency)}`;

  const onAdd = useCallback(async () => {
    if (withVariants && !variant) {
      setAddError(t('product.chooseFirst'));
      return;
    }
    setAdding(true);
    setAddError(null);
    setAdded(null);
    try {
      await add(product.id, variant?.id ?? null, qty);
      // Stay on the product: say what went in and start again from 1.
      setAdded(`${productTitle(product)}${variant ? ` · ${variant.label}` : ''} ×${qty}`);
      setQuantity(1);
      try {
        if (hapticFeedback.notificationOccurred.isAvailable()) hapticFeedback.notificationOccurred('success');
      } catch {
        // Not inside Telegram.
      }
    } catch (err) {
      setAddError(err instanceof ApiClientError ? err.message : t('product.addFailed'));
    } finally {
      setAdding(false);
    }
  }, [product, withVariants, variant, qty, add]);

  useMainButton({
    text: shop.isClosed
      ? t('closed.short')
      : outOfStock
      ? t('product.outOfStock')
      : missing
        ? t('product.chooseOption')
        : qty > 1
          ? t('product.addManyToCart', {
              count: qty,
              total: formatPrice(unitPrice * qty, product.currency),
            })
          : t('product.addToCart'),
    visible: true,
    enabled: !shop.isClosed && !outOfStock && !missing,
    loading: adding,
    onClick: onAdd,
  });

  const tiers = tierTable(product, variant, vip);
  const vipShown = variant ? vipPriceFor(product, variant, vip) !== null : hasVipPrice(product, vip);

  const inCart = (cart?.lines ?? [])
    .filter((line) => line.product.id === product.id)
    .reduce((sum, line) => sum + line.quantity, 0);

  const choose = (index: number, value: string): void =>
    setSelected((prev) => prev.map((v, i) => (i === index ? (v === value ? null : value) : v)));

  return (
    <List>
      <Section>
        <ProductImage url={product.imageUrl} alt={productTitle(product)} />
        <div style={{ padding: 16 }}>
          <Title level="2" weight="2">
            {productTitle(product)}
          </Title>
          <Title level="3" weight="1" style={{ marginTop: 8 }}>
            {priceText}
          </Title>
          {/* What matters before adding it, as labels. */}
          {(outOfStock || product.vipOnly || vipShown || product.minQuantity > 1 || inCart > 0) && (
            <div className="gb-chips" style={{ marginTop: 10 }}>
              {outOfStock && <span className="gb-chip gb-chip--warn">{t('product.outOfStock')}</span>}
              {product.vipOnly && <span className="gb-chip gb-chip--vip">{t('product.vipOnly')}</span>}
              {vipShown && <span className="gb-chip gb-chip--vip">{t('product.vipPrice')}</span>}
              {product.minQuantity > 1 && (
                <span className="gb-chip">
                  {withVariants
                    ? t('product.minimumMixed', { count: product.minQuantity })
                    : t('product.minimum', { count: product.minQuantity })}
                </span>
              )}
              {inCart > 0 && (
                <span className="gb-chip gb-chip--info">{t('catalog.inCart', { count: inCart })}</span>
              )}
            </div>
          )}
          {other && otherText && (
            <Text style={{ display: 'block', marginTop: 4, opacity: 0.7 }}>
              {t('exchange.approx', { price: otherText })} · {t('exchange.choose', { a: product.currency, b: other.token })}
            </Text>
          )}
          <Text style={{ display: 'block', marginTop: 12 }}>{productDescription(product)}</Text>
        </div>
      </Section>

      {product.options.map((option, index) => (
        <Section key={option.name} header={option.name}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
            {option.values.map((value) => {
              const available = isValueAvailable(product, selected, index, value);
              return (
                <Button
                  key={value}
                  size="s"
                  mode={selected[index] === value ? 'filled' : 'bezeled'}
                  disabled={!available && selected[index] !== value}
                  onClick={() => choose(index, value)}
                >
                  {value}
                </Button>
              );
            })}
          </div>
        </Section>
      ))}

      {tiers.length > 0 && (
        <Section
          header={t('product.volumePricing')}
          footer={withVariants ? t('product.volumeFooterVariants') : t('product.volumeFooter')}
        >
          {tiers.map((tier) => (
            <Cell key={tier.from} after={formatPrice(tier.price, product.currency)}>
              {tier.to === null
                ? t('product.unitsFrom', { from: tier.from })
                : tier.from === tier.to
                  ? tn(tier.from, 'units.one', 'units.other')
                  : t('product.unitsRange', { from: tier.from, to: tier.to })}
            </Cell>
          ))}
        </Section>
      )}

      {!outOfStock && (
        <Section header={t('product.quantity')}>
          <Cell
            subtitle={
              missing
                ? t('product.chooseOption')
                : `${qty} × ${formatPrice(unitPrice, product.currency)} = ${formatPrice(
                    unitPrice * qty,
                    product.currency,
                  )}`
            }
            after={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Button
                  size="s"
                  mode="bezeled"
                  disabled={qty <= 1}
                  onClick={() => setQuantity(Math.max(1, qty - 1))}
                >
                  −
                </Button>
                <span style={{ minWidth: 24, textAlign: 'center' }}>{qty}</span>
                <Button
                  size="s"
                  mode="bezeled"
                  disabled={qty >= maxQuantity}
                  onClick={() => setQuantity(Math.min(maxQuantity, qty + 1))}
                >
                  +
                </Button>
              </div>
            }
          >
            {t('product.howMany')}
          </Cell>
        </Section>
      )}

      {(added || itemCount > 0) && (
        <Section>
          {added && (
            <Cell multiline style={{ color: '#31b545' }}>
              {t('product.added', { item: added })}
            </Cell>
          )}
          {itemCount > 0 && (
            <Cell onClick={() => navigate(to('/cart'))} after="›">
              {t('product.viewCart', { count: itemCount })}
            </Cell>
          )}
        </Section>
      )}

      {addError && (
        <div className="gb-notice gb-notice--error" role="alert">
          <Cell multiline>
            {addError}
          </Cell>
        </div>
      )}
      <Section>
        <Cell
          after={
            missing
              ? t('product.chooseOption')
              : stock === null
                ? t('product.inStock')
                : stock > 0
                  ? t('product.left', { count: stock })
                  : t('product.outOfStock')
          }
        >
          {t('product.availability')}
        </Cell>
      </Section>
    </List>
  );
}
