import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, Checkbox, List, Placeholder, Section, Switch } from '@telegram-apps/telegram-ui';
import type { CloneProductsResult, CloneSource } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { useShop, useShopPath } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t, tn } from '../../i18n/index.js';

/** Copy products (with variants, volume prices and categories) from another shop. */
export function AdminClonePage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminClone />
    </AdminOnly>
  );
}

function AdminClone(): React.JSX.Element {
  const sources = useAsync(() => api.adminGetCloneSources(), []);
  const [sourceId, setSourceId] = useState<string | null>(null);

  if (sources.loading && !sources.data) return <Loader />;
  if (sources.error) return <ErrorView message={sources.error} />;
  const list = sources.data ?? [];
  if (list.length === 0) {
    return (
      <Placeholder header={t('clone.noSources')} description={t('clone.noSourcesHint')}>
        <span style={{ fontSize: 48 }}>📋</span>
      </Placeholder>
    );
  }
  const source = list.find((s) => s.id === sourceId) ?? null;

  return (
    <List>
      <PageTitle title={t('adminHome.clone')} />
      <Section header={t('clone.from')} footer={t('clone.footer')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
          {list.map((shop) => (
            <Button
              key={shop.id}
              size="s"
              mode={shop.id === sourceId ? 'filled' : 'bezeled'}
              onClick={() => setSourceId(shop.id)}
            >
              {shop.name}
            </Button>
          ))}
        </div>
      </Section>
      {source && <ClonePicker key={source.id} source={source} />}
    </List>
  );
}

function ClonePicker({ source }: { source: CloneSource }): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const { shop } = useShop();
  const actions = useAdminActions(() => undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copyStock, setCopyStock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloneProductsResult | null>(null);

  const groups = useMemo(() => {
    const byCategory = source.categories.map((c) => ({
      key: c.id,
      title: c.title,
      items: source.products.filter((p) => p.categoryId === c.id),
    }));
    const loose = source.products.filter(
      (p) => p.categoryId === null || !source.categories.some((c) => c.id === p.categoryId),
    );
    return [...byCategory, { key: 'none', title: t('adminCatalog.noCategory'), items: loose }].filter(
      (g) => g.items.length > 0,
    );
  }, [source]);

  const allIds = source.products.map((p) => p.id);
  const allOn = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const setMany = (ids: string[], on: boolean): void => {
    setResult(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const copy = async (): Promise<void> => {
    setBusy(true);
    await actions.run(async () => {
      setResult(
        await api.adminCloneProducts({
          sourceShopId: source.id,
          productIds: [...selected],
          copyStock,
        }),
      );
      setSelected(new Set());
    });
    setBusy(false);
  };

  if (source.products.length === 0) {
    return (
      <Section>
        <Cell multiline>{t('clone.emptySource')}</Cell>
      </Section>
    );
  }

  return (
    <>
      <ErrorBanner message={actions.error} />
      {result && (
        <Section>
          <Cell multiline>
            {t('clone.done', {
              products: tn(result.products, 'count.products.one', 'count.products.other'),
              shop: shop.name,
            })}
            {result.categories > 0 ? ` ${t('clone.newCategories', { count: result.categories })}` : ''}
          </Cell>
          <div style={{ padding: '0 16px 16px' }}>
            <Button size="s" mode="bezeled" onClick={() => navigate(to('/admin/catalog'))}>
              {t('adminHome.catalog')}
            </Button>
          </div>
        </Section>
      )}

      <Section>
        <Cell
          Component="label"
          before={<Checkbox checked={allOn} onChange={(e) => setMany(allIds, e.target.checked)} />}
        >
          <strong>{t('clone.everything', { count: allIds.length })}</strong>
        </Cell>
      </Section>

      {groups.map((group) => {
        const ids = group.items.map((p) => p.id);
        const groupOn = ids.every((id) => selected.has(id));
        return (
          <Section key={group.key}>
            <Cell
              Component="label"
              before={<Checkbox checked={groupOn} onChange={(e) => setMany(ids, e.target.checked)} />}
            >
              <strong>{group.title}</strong>
            </Cell>
            {group.items.map((product) => (
              <Cell
                key={product.id}
                Component="label"
                before={
                  <Checkbox
                    checked={selected.has(product.id)}
                    onChange={(e) => setMany([product.id], e.target.checked)}
                  />
                }
                subtitle={
                  [
                    product.variantCount > 0
                      ? tn(product.variantCount, 'count.variants.one', 'count.variants.other')
                      : null,
                    product.isActive ? null : t('adminCatalog.hidden'),
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
              >
                {product.title}
              </Cell>
            ))}
          </Section>
        );
      })}

      <Section footer={t('clone.stockFooter')}>
        <Cell
          Component="label"
          after={<Switch checked={copyStock} onChange={(e) => setCopyStock(e.target.checked)} />}
          multiline
        >
          {t('clone.copyStock')}
        </Cell>
      </Section>

      <Section footer={t('clone.hiddenFooter')}>
        <div style={{ padding: 16 }}>
          <Button stretched loading={busy} disabled={selected.size === 0} onClick={() => void copy()}>
            {selected.size === 0
              ? t('clone.chooseProducts')
              : t('clone.copy', {
                  products: tn(selected.size, 'count.products.one', 'count.products.other'),
                })}
          </Button>
        </div>
      </Section>
    </>
  );
}
