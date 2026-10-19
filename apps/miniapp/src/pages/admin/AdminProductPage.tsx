import { useNavigate, useParams } from 'react-router-dom';
import { List } from '@telegram-apps/telegram-ui';
import type { Product } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { ProductForm } from './ProductForm.js';
import { AdminOnly, TOKENS } from './common.js';
import { useShopPath } from '../../providers/ShopProvider.js';
import { t } from '../../i18n/index.js';

/** `/admin/products/new` creates a product; `/admin/products/:id` edits one. */
export function AdminProductPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminProduct />
    </AdminOnly>
  );
}

function AdminProduct(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const { id } = useParams();
  const isNew = id === undefined || id === 'new';

  const shop = useAsync(() => api.getShop(), []);
  const categories = useAsync(() => api.getCategories(), []);
  // Admin listing includes hidden products, so hidden ones can be edited too.
  const products = useAsync(
    (): Promise<Product[]> => (isNew ? Promise.resolve([]) : api.adminGetProducts()),
    [id],
  );

  if (shop.loading || categories.loading || products.loading) return <Loader />;
  const error = shop.error ?? categories.error ?? products.error;
  if (error) return <ErrorView message={error} />;

  const product = isNew ? null : (products.data?.find((p) => p.id === id) ?? null);
  if (!isNew && !product) return <ErrorView message={t('product.notFound')} />;

  const defaultToken = TOKENS.find((token) => token === shop.data?.currency) ?? 'USDC';
  // After editing go back to the catalog; after creating stay, to add another.
  const onSaved = (): void => {
    if (!isNew) navigate(to('/admin/catalog'));
  };

  return (
    <List>
      <ProductForm
        key={product?.id ?? 'new'}
        product={product}
        categories={categories.data ?? []}
        defaultToken={defaultToken}
        onSaved={onSaved}
        onCancel={() => navigate(-1)}
      />
    </List>
  );
}
