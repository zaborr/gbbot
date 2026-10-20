import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { Button, Placeholder } from '@telegram-apps/telegram-ui';
import type { ShopConfig } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { Loader } from '../components/Loader.js';
import { CartProvider } from './CartProvider.js';
import { DisclaimerGate } from '../components/DisclaimerGate.js';
import { t } from '../i18n/index.js';

interface ShopValue {
  shop: ShopConfig;
  /** Whether the current user is this shop's admin (or a platform super-admin). */
  canManage: boolean;
  /** Reloads the shop config (after editing its settings). */
  reload: () => void;
  /** Absolute app path inside this shop: `to('/cart')` → `/s/tea-shop/cart`. */
  to: (path: string) => string;
}

const ShopContext = createContext<ShopValue | null>(null);

export function shopPath(ref: string, path = '/'): string {
  const base = `/s/${encodeURIComponent(ref)}`;
  return path === '/' || path === '' ? base : `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Route element for `/s/:shopRef/*`. Points the API client at the shop, loads
 * its config and gives the nested screens their own cart.
 */
export function ShopLayout(): React.JSX.Element {
  const { shopRef = '' } = useParams();
  // Set during render: nested screens fetch in their effects, which run before ours.
  api.setShop(shopRef);
  // A fresh subtree per shop, so nothing from the previous shop leaks in.
  return <ShopScope key={shopRef} shopRef={shopRef} />;
}

function ShopScope({ shopRef }: { shopRef: string }): React.JSX.Element {
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const shop = useAsync(() => api.getShop(), [shopRef, reloadKey]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const to = useCallback((path: string) => shopPath(shopRef, path), [shopRef]);

  const value = useMemo<ShopValue | null>(
    () => (shop.data ? { shop: shop.data, canManage: shop.data.canManage, reload, to } : null),
    [shop.data, reload, to],
  );

  if (shop.error) {
    return (
      <Placeholder header={t('shop.unavailable')} description={shop.error}>
        <span style={{ fontSize: 48 }}>🏪</span>
        <Button onClick={() => navigate('/')}>{t('shop.allShops')}</Button>
      </Placeholder>
    );
  }
  if (!value) return <Loader />;
  // The GB's conditions first (admins never see this).
  if (value.shop.disclaimer && !value.shop.disclaimerAccepted) {
    return <DisclaimerGate shop={value.shop} onAccepted={reload} />;
  }

  return (
    <ShopContext.Provider value={value}>
      <CartProvider>
        <Outlet />
      </CartProvider>
    </ShopContext.Provider>
  );
}

export function useShop(): ShopValue {
  const ctx = useContext(ShopContext);
  if (!ctx) throw new Error('useShop must be used inside a shop route');
  return ctx;
}

/** Shorthand for `useShop().to`. */
export function useShopPath(): (path: string) => string {
  return useShop().to;
}
