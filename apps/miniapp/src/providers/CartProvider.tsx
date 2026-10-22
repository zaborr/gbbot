import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Cart } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { useSession } from './SessionProvider.js';
import { isWebMode } from '../lib/web.js';

interface CartValue {
  cart: Cart | null;
  loading: boolean;
  itemCount: number;
  refresh: () => Promise<void>;
  add: (productId: string, variantId: string | null, quantity: number) => Promise<void>;
  /** By cart line id. */
  setQuantity: (lineId: string, quantity: number) => Promise<void>;
  remove: (lineId: string) => Promise<void>;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { status } = useSession();
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCart(await api.getCart());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Web administrators have no cart.
    if (status === 'ready' && !isWebMode()) void refresh();
  }, [status, refresh]);

  const add = useCallback(async (productId: string, variantId: string | null, quantity: number) => {
    setCart(await api.addToCart(productId, variantId, quantity));
  }, []);

  const setQuantity = useCallback(async (lineId: string, quantity: number) => {
    setCart(await api.setCartItem(lineId, quantity));
  }, []);

  const remove = useCallback(async (lineId: string) => {
    setCart(await api.removeCartItem(lineId));
  }, []);

  const value = useMemo<CartValue>(
    () => ({ cart, loading, itemCount: cart?.itemCount ?? 0, refresh, add, setQuantity, remove }),
    [cart, loading, refresh, add, setQuantity, remove],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider');
  return ctx;
}
