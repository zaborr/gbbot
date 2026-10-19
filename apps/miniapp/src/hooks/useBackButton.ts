import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { backButton } from '@telegram-apps/sdk-react';

const SHOP_ROOT = /^\/s\/[^/]+\/?$/;

/**
 * Telegram BackButton: hidden on the shop list; on a shop's catalog it goes back
 * to the shop list; everywhere else it goes back one screen.
 */
export function useBackButton(): void {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!backButton.isSupported() || !backButton.isMounted()) return;
    if (location.pathname === '/') {
      backButton.hide();
      return;
    }
    backButton.show();
    const atShopRoot = SHOP_ROOT.test(location.pathname);
    const off = backButton.onClick(() => (atShopRoot ? navigate('/') : navigate(-1)));
    return () => {
      off();
    };
  }, [location.pathname, navigate]);
}
