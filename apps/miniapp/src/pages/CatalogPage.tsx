import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { awaitsPayment, type Product, type Testing } from '@tma-shop/shared';
import { Input } from '../components/Field.js';
import { UnpaidOrdersBanner } from '../components/UnpaidOrdersBanner.js';
import { ClosingNotice, closingDate, closingSoon } from '../components/ClosingNotice.js';
import { TestingEntry } from '../components/TestingEntry.js';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { useCart } from '../providers/CartProvider.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { ProductCard } from '../components/ProductCard.js';
import { productTestingState, testingLive } from '../lib/testingState.js';
import { ProductImage } from '../components/ProductImage.js';
import { useShop, useShopPath } from '../providers/ShopProvider.js';
import { t } from '../i18n/index.js';
import { shopDescription, shopName } from '../lib/localize.js';
import { OrganizedBy } from '../components/OrganizedBy.js';
import { GoalBar } from '../components/GoalBar.js';
import { useMainButton } from '../hooks/useMainButton.js';
import { formatPrice } from '../lib/format.js';

/** Products loaded at a time (all of a GB, as a rule: they are shown by category); "Show more" brings the rest. */
const PAGE_SIZE = 150;
/** Room the category bar takes at the top, for jumping to a section. */
const BAR_OFFSET = 64;

/**
 * Where the customer was in each GB's catalog (filters, extra pages, scroll),
 * so coming back from a product puts them in the same place.
 */
interface CatalogPlace {
  search: string;
  onlyTesting: boolean;
  more: { items: Product[]; page: number };
  scrollY: number;
}
const places = new Map<string, CatalogPlace>();

export function CatalogPage(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const { itemCount, cart } = useCart();
  const { shop, canManage } = useShop();
  const [place] = useState(() => places.get(shop.id));
  const [search, setSearch] = useState(place?.search ?? '');
  const [onlyTesting, setOnlyTesting] = useState(place?.onlyTesting ?? false);

  const categories = useAsync(() => api.getCategories(), []);
  // Orders still to pay: a note at the top and a badge on "My orders".
  const myOrders = useAsync(() => api.getOrders(), []);
  // Open testings, for a label on their products (none when the GB has testing off).
  const testings = useAsync(() => (shop.testingEnabled ? api.getTestings() : Promise.resolve<Testing[]>([])), [
    shop.testingEnabled,
  ]);
  const unpaid = (myOrders.data ?? []).filter(awaitsPayment);
  const query = { search: search.trim() || undefined, ...(onlyTesting ? { testing: '1' as const } : {}) };
  const products = useAsync(() => api.getProducts({ ...query, limit: PAGE_SIZE }), [search, onlyTesting]);
  // Further pages, appended below the first; cleared when the search or the
  // category changes (an answer for an old search is dropped).
  const [more, setMore] = useState<{ items: Product[]; page: number }>(
    () => place?.more ?? { items: [], page: 1 },
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const queryKey = useRef('');
  const firstRun = useRef(true);
  useEffect(() => {
    queryKey.current = `${search}|${onlyTesting}`;
    // On arrival the remembered pages stay; a new search starts again.
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setMore({ items: [], page: 1 });
  }, [search, onlyTesting]);

  // Remember the place when leaving; scroll back to it once the list is there.
  const latest = useRef({ search, onlyTesting, more });
  latest.current = { search, onlyTesting, more };
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
  const loaded = [...(products.data?.items ?? []), ...more.items].filter((p) =>
    seen.has(p.id) ? false : (seen.add(p.id), true),
  );
  // Only those with a testing: the closest to their next tier first.
  const openTestings = (testings.data ?? []).filter(testingLive);
  const items = onlyTesting
    ? [...loaded].sort(
        (a, b) =>
          (productTestingState(a.id, openTestings)?.distance ?? 3) -
          (productTestingState(b.id, openTestings)?.distance ?? 3),
      )
    : loaded;
  const testedProducts = new Set(openTestings.map((x) => x.productId));
  const reachedProducts = new Set(
    [...testedProducts].filter((id) => (productTestingState(id, openTestings)?.reached.length ?? 0) > 0),
  );
  const total = products.data?.total ?? 0;
  // As in the admin: one section per category (in its order), the rest at the end.
  // A search shows its results as one list.
  const categoryList = categories.data ?? [];
  const grouped = !search.trim() && categoryList.length > 0;
  const groups = grouped
    ? [
        ...categoryList.map((c) => ({ key: c.id, title: c.title, items: items.filter((p) => p.categoryId === c.id) })),
        {
          key: 'other',
          title: t('catalog.other'),
          items: items.filter((p) => p.categoryId === null || !categoryList.some((c) => c.id === p.categoryId)),
        },
      ].filter((g) => g.items.length > 0)
    : [];
  // Only "Others": no point in a bar or a title.
  const sections = groups.length === 1 && groups[0]!.key === 'other' ? [] : groups;
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (sections.length === 0) return;
    // The category being read: the last whose title is past the bar.
    const onScroll = (): void => {
      let current: string | null = sections[0]!.key;
      for (const g of sections) {
        const el = document.getElementById(`gb-cat-${g.key}`);
        if (el && el.getBoundingClientRect().top <= BAR_OFFSET + 8) current = g.key;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [sections.map((g) => g.key).join('|')]);
  useEffect(() => {
    // The chip of the category being read stays in sight in the bar.
    if (active) document.getElementById(`gb-chip-${active}`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active]);
  const jump = (key: string): void => {
    document.getElementById(`gb-cat-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // With something in the cart, the bottom button leads to it (with its total).
  useMainButton({
    text: cart
      ? t('catalog.toCartTotal', { total: formatPrice(cart.total, cart.currency) })
      : t('catalog.toCart'),
    visible: itemCount > 0 && !shop.isClosed,
    onClick: () => navigate(to('/cart')),
  });

  const headerLine = [
    !shop.isVisible ? t('catalog.hiddenShop') : shop.vipOnly ? t(shop.allowGuests ? 'catalog.guestShop' : 'catalog.vipShop') : null,
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
          before={shop.imageUrl ? <ProductImage url={shop.imageUrl} alt={shopName(shop)} size={48} /> : undefined}
          subtitle={shopDescription(shop) || undefined}
          description={
            headerLine || shop.organizers.length > 0 ? (
              <>
                {headerLine}
                <OrganizedBy organizers={shop.organizers} hidden={shop.canManage && !shop.showOrganizers} />
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
      {/* The testings: those one is in and those one can join, on their own screen. */}
      {shop.testingEnabled && <TestingEntry onOpen={() => navigate(to('/testing'))} />}
      <UnpaidOrdersBanner orders={unpaid} />
      {/* The two places a customer comes back to, always in sight. */}
      <div className="gb-tiles">
        {!shop.isClosed && (
          <button type="button" className="gb-tile" onClick={() => navigate(to('/cart'))}>
            {t('catalog.cart')}
            {itemCount > 0 && (
              <span style={{ marginLeft: 'auto' }}>
                <Badge type="number">{itemCount}</Badge>
              </span>
            )}
          </button>
        )}
        <button type="button" className="gb-tile" onClick={() => navigate(to('/orders'))}>
          {t('catalog.myOrders')}
          {unpaid.length > 0 && (
            <span style={{ marginLeft: 'auto' }}>
              <Badge type="number" mode="critical">
                {unpaid.length}
              </Badge>
            </span>
          )}
        </button>
      </div>
      {canManage && (
        <Section>
          <Cell onClick={() => navigate(to('/admin'))}>{t('catalog.admin')}</Cell>
        </Section>
      )}

      {testedProducts.size > 0 && (
        <Section>
          <Cell
            multiline
            after={
              <Button size="s" mode={onlyTesting ? 'filled' : 'bezeled'} onClick={() => setOnlyTesting(!onlyTesting)}>
                {onlyTesting ? t('catalog.testingShowAll') : t('catalog.testingOnly')}
              </Button>
            }
            subtitle={onlyTesting ? t('catalog.testingSorted') : undefined}
          >
            {reachedProducts.size > 0
              ? t('catalog.testingSummaryReached', { count: testedProducts.size, reached: reachedProducts.size })
              : t('catalog.testingSummary', { count: testedProducts.size })}
          </Cell>
        </Section>
      )}

      <Section header={t('catalog.title')}>
        <Input
          placeholder={t('catalog.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Section>

      {products.loading && <Loader />}
      {products.error && <ErrorView message={products.error} />}
      {products.data && sections.length > 0 && (
        <div className="gb-catbar" role="tablist">
          {sections.map((g) => (
            <Button
              key={g.key}
              id={`gb-chip-${g.key}`}
              size="s"
              mode={active === g.key ? 'filled' : 'bezeled'}
              onClick={() => jump(g.key)}
            >
              {g.title}
            </Button>
          ))}
        </div>
      )}
      {products.data &&
        sections.map((g) => (
          <div key={g.key} id={`gb-cat-${g.key}`} style={{ scrollMarginTop: BAR_OFFSET }}>
            <Section header={g.title}>
              {g.items.map((product) => (
                <ProductCard key={product.id} product={product} testings={testings.data ?? []} />
              ))}
            </Section>
          </div>
        ))}
      {products.data && (items.length === 0 || sections.length === 0 || items.length < total) && (
        <Section>
          {items.length === 0 ? (
            <Cell>{t('catalog.noProducts')}</Cell>
          ) : sections.length > 0 ? null : (
            items.map((product) => (
              <ProductCard key={product.id} product={product} testings={testings.data ?? []} />
            ))
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
