import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { awaitsPayment, type Product } from '@tma-shop/shared';
import { Input } from '../components/Field.js';
import { UnpaidOrdersBanner } from '../components/UnpaidOrdersBanner.js';
import { ClosingNotice, closingDate, closingSoon } from '../components/ClosingNotice.js';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useCart } from '../providers/CartProvider.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { ProductCard } from '../components/ProductCard.js';
import { ProductImage } from '../components/ProductImage.js';
import { useShop, useShopPath } from '../providers/ShopProvider.js';
import { t } from '../i18n/index.js';
import { shopDescription, shopName } from '../lib/localize.js';
import { OrganizedBy } from '../components/OrganizedBy.js';
import { GoalBar } from '../components/GoalBar.js';

/** Products loaded at a time; "Show more" brings the next ones. */
const PAGE_SIZE = 30;

/**
 * Where the customer was in each GB's catalog (filters, extra pages, scroll),
 * so coming back from a product puts them in the same place.
 */
interface CatalogPlace {
  categoryId: string | undefined;
  search: string;
  more: { items: Product[]; page: number };
  scrollY: number;
}
const places = new Map<string, CatalogPlace>();

export function CatalogPage(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const { itemCount } = useCart();
  const { shop, canManage } = useShop();
  const [place] = useState(() => places.get(shop.id));
  const [categoryId, setCategoryId] = useState<string | undefined>(place?.categoryId);
  const [search, setSearch] = useState(place?.search ?? '');

  const categories = useAsync(() => api.getCategories(), []);
  // Orders still to pay: a note at the top and a badge on "My orders".
  const myOrders = useAsync(() => api.getOrders(), []);
  const unpaid = (myOrders.data ?? []).filter(awaitsPayment);
  const query = { categoryId, search: search.trim() || undefined };
  const products = useAsync(() => api.getProducts({ ...query, limit: PAGE_SIZE }), [categoryId, search]);
  // Further pages, appended below the first; cleared when the search or the
  // category changes (an answer for an old search is dropped).
  const [more, setMore] = useState<{ items: Product[]; page: number }>(
    () => place?.more ?? { items: [], page: 1 },
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const queryKey = useRef('');
  const firstRun = useRef(true);
  useEffect(() => {
    queryKey.current = `${categoryId ?? ''}|${search}`;
    // On arrival the remembered pages stay; a new search starts again.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setMore({ items: [], page: 1 });
  }, [categoryId, search]);

  // Remember the place when leaving; scroll back to it once the list is there.
  const latest = useRef({ categoryId, search, more });
  latest.current = { categoryId, search, more };
  useEffect(
    () => () => {
      places.set(shop.id, { ...latest.current, scrollY: window.scrollY });
    },
    [shop.id],
  );
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !products.data) return;
    restored.current = true;
    if (place && place.scrollY > 0) {
      requestAnimationFrame(() => window.scrollTo(0, place.scrollY));
    }
  }, [products.data, place]);

  const loadMore = async (): Promise<void> => {
    const key = queryKey.current;
    setLoadingMore(true);
    try {
      const next = await api.getProducts({ ...query, limit: PAGE_SIZE, page: more.page + 1 });
      if (key === queryKey.current) setMore((prev) => ({ items: [...prev.items, ...next.items], page: next.page }));
    } catch {
      // The button stays: tapping it again retries.
    } finally {
      setLoadingMore(false);
    }
  };

  // A product added meanwhile shifts the pages: never show one twice.
  const seen = new Set<string>();
  const items = [...(products.data?.items ?? []), ...more.items].filter((p) =>
    seen.has(p.id) ? false : (seen.add(p.id), true),
  );
  const total = products.data?.total ?? 0;

  const headerLine = [
    !shop.isVisible ? t('catalog.hiddenShop') : shop.vipOnly ? t('catalog.vipShop') : null,
    // Far from the closing: just a short line here (the big notice comes later).
    !shop.isClosed && shop.closesAt && !closingSoon(shop)
      ? t('shops.closes', { date: closingDate(shop.closesAt) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <List>
      <Section>
        <Cell
          before={<ProductImage url={shop.imageUrl} alt={shopName(shop)} size={48} />}
          subtitle={shopDescription(shop) || undefined}
          description={
            headerLine || shop.organizers.length > 0 ? (
              <>
                {headerLine}
                <OrganizedBy organizers={shop.organizers} />
              </>
            ) : undefined
          }
          multiline
        >
          <strong>{shopName(shop)}</strong>
        </Cell>
        {shop.goal && (
          <div style={{ padding: '0 16px 12px' }}>
            <GoalBar goal={shop.goal} closesAt={shop.closesAt} />
          </div>
        )}
      </Section>
      <ClosingNotice shop={shop} />
      <UnpaidOrdersBanner orders={unpaid} />
      <Section>
        {!shop.isClosed && (
          <Cell
            onClick={() => navigate(to('/cart'))}
            after={itemCount > 0 ? <Badge type="number">{itemCount}</Badge> : undefined}
          >
            {t('catalog.cart')}
          </Cell>
        )}
        <Cell
          onClick={() => navigate(to('/orders'))}
          after={
            unpaid.length > 0 ? (
              <Badge type="number" mode="critical">
                {unpaid.length}
              </Badge>
            ) : undefined
          }
        >
          {t('catalog.myOrders')}
        </Cell>
        {canManage && <Cell onClick={() => navigate(to('/admin'))}>{t('catalog.admin')}</Cell>}
      </Section>

      <Section header={t('catalog.title')}>
        <Input
          placeholder={t('catalog.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, padding: '8px 16px', flexWrap: 'wrap' }}>
          <Button
            size="s"
            mode={categoryId === undefined ? 'filled' : 'bezeled'}
            onClick={() => setCategoryId(undefined)}
          >
            {t('catalog.all')}
          </Button>
          {categories.data?.map((category) => (
            <Button
              key={category.id}
              size="s"
              mode={categoryId === category.id ? 'filled' : 'bezeled'}
              onClick={() => setCategoryId(category.id)}
            >
              {category.title}
            </Button>
          ))}
        </div>
      </Section>

      {products.loading && <Loader />}
      {products.error && <ErrorView message={products.error} />}
      {products.data && (
        <Section>
          {items.length === 0 ? (
            <Cell>{t('catalog.noProducts')}</Cell>
          ) : (
            items.map((product) => <ProductCard key={product.id} product={product} />)
          )}
          {items.length < total && (
            <div style={{ padding: 16 }}>
              <Button stretched mode="bezeled" loading={loadingMore} onClick={() => void loadMore()}>
                {t('catalog.showMore', { shown: items.length, total })}
              </Button>
            </div>
          )}
        </Section>
      )}
    </List>
  );
}
