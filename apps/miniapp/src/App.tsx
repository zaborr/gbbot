import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { retrieveLaunchParams } from '@telegram-apps/sdk-react';
import { AppRoot, Placeholder } from '@telegram-apps/telegram-ui';
import { SessionProvider, useSession } from './providers/SessionProvider.js';
import { ShopLayout, shopPath } from './providers/ShopProvider.js';
import { useBackButton } from './hooks/useBackButton.js';
import { useMainButtonReset } from './hooks/useMainButton.js';
import { useAppearance, useAppearanceChrome } from './hooks/useAppearance.js';
import { Loader } from './components/Loader.js';
import { CatalogPage } from './pages/CatalogPage.js';
import { ProductPage } from './pages/ProductPage.js';
import { CartPage } from './pages/CartPage.js';
import { OrdersPage } from './pages/OrdersPage.js';
import { PaymentPage } from './pages/PaymentPage.js';
import { AdminHomePage } from './pages/admin/AdminHomePage.js';
import { AdminCatalogPage } from './pages/admin/AdminCatalogPage.js';
import { AdminProductPage } from './pages/admin/AdminProductPage.js';
import { AdminFeePage } from './pages/admin/AdminFeePage.js';
import { AdminOrdersPage } from './pages/admin/AdminOrdersPage.js';
import { AdminOrderPage } from './pages/admin/AdminOrderPage.js';
import { AdminSummaryPage } from './pages/admin/AdminSummaryPage.js';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage.js';
import { AdminWalletsPage } from './pages/admin/AdminWalletsPage.js';
import { AdminShippingPage } from './pages/admin/AdminShippingPage.js';
import { AdminAddressKeyPage } from './pages/admin/AdminAddressKeyPage.js';
import { AdminExportPage } from './pages/admin/AdminExportPage.js';
import { AdminVipPage } from './pages/admin/AdminVipPage.js';
import { AdminClonePage } from './pages/admin/AdminClonePage.js';
import { AdminClosePage } from './pages/admin/AdminClosePage.js';
import { AdminOwnerPage } from './pages/admin/AdminOwnerPage.js';
import { AdminProductsCsvPage } from './pages/admin/AdminProductsCsvPage.js';
import { AdminBroadcastPage } from './pages/admin/AdminBroadcastPage.js';
import { AdminDisclaimerPage } from './pages/admin/AdminDisclaimerPage.js';
import { AdminUnpaidPage } from './pages/admin/AdminUnpaidPage.js';
import { NewShopPage } from './pages/NewShopPage.js';
import { ImportShopPage } from './pages/ImportShopPage.js';
import { UploadPage } from './pages/UploadPage.js';
import { ShopsPage } from './pages/ShopsPage.js';
import { PlatformPage } from './pages/platform/PlatformPage.js';
import { PlatformShopPage } from './pages/platform/PlatformShopPage.js';
import { PlatformRetentionPage } from './pages/platform/PlatformRetentionPage.js';
import { PlatformVipPage } from './pages/platform/PlatformVipPage.js';
import { PlatformOrganizersPage } from './pages/platform/PlatformOrganizersPage.js';
import { lang, onLangChange, t } from './i18n/index.js';
import { isWebMode } from './lib/web.js';
import { WebMainButton, WebSignIn, WebTopBar } from './components/WebChrome.js';

/** Web mode has no customer screens (no cart, no orders): a GB opens on its admin. */
function WebToAdmin(): React.JSX.Element {
  const { shopRef = '' } = useParams();
  return <Navigate to={shopPath(shopRef, '/admin')} replace />;
}

/** A customer screen; in web mode, the GB's admin instead. */
const customer = (element: React.JSX.Element): React.JSX.Element =>
  isWebMode() ? <WebToAdmin /> : element;

function platform(): 'ios' | 'base' {
  try {
    return retrieveLaunchParams().tgWebAppPlatform === 'ios' ? 'ios' : 'base';
  } catch {
    return 'base';
  }
}

function Shell(): React.JSX.Element {
  useBackButton();
  useMainButtonReset();
  const { status, error } = useSession();

  if (status === 'loading') return <Loader />;
  if (status === 'signin') return <WebSignIn />;
  if (status === 'error') {
    return (
      <Placeholder header={t('app.signInFailed')} description={error ?? t('app.reopen')}>
        <span style={{ fontSize: 48 }}>🔒</span>
      </Placeholder>
    );
  }

  const routes = (
    <Routes>
      <Route path="/" element={<ShopsPage />} />
      <Route path="/platform" element={<PlatformPage />} />
      <Route path="/platform/shops/:id" element={<PlatformShopPage />} />
      <Route path="/platform/retention" element={<PlatformRetentionPage />} />
      <Route path="/platform/vip" element={<PlatformVipPage />} />
      <Route path="/platform/organizers" element={<PlatformOrganizersPage />} />
      <Route path="/new-gb" element={<NewShopPage />} />
      <Route path="/import-gb" element={<ImportShopPage />} />
      <Route path="/upload/:id" element={<UploadPage />} />

      <Route path="/s/:shopRef" element={<ShopLayout />}>
        <Route index element={customer(<CatalogPage />)} />
        <Route path="product/:id" element={customer(<ProductPage />)} />
        <Route path="cart" element={customer(<CartPage />)} />
        <Route path="orders" element={customer(<OrdersPage />)} />
        <Route path="orders/:id" element={customer(<PaymentPage />)} />
        <Route path="admin" element={<AdminHomePage />} />
        <Route path="admin/catalog" element={<AdminCatalogPage />} />
        <Route path="admin/products/:id" element={<AdminProductPage />} />
        <Route path="admin/fee" element={<AdminFeePage />} />
        <Route path="admin/settings" element={<AdminSettingsPage />} />
        <Route path="admin/wallets" element={<AdminWalletsPage />} />
        <Route path="admin/shipping" element={<AdminShippingPage />} />
        <Route path="admin/address-key" element={<AdminAddressKeyPage />} />
        <Route path="admin/orders" element={<AdminOrdersPage />} />
        <Route path="admin/orders/:id" element={<AdminOrderPage />} />
        <Route path="admin/summary" element={<AdminSummaryPage />} />
        <Route path="admin/export" element={<AdminExportPage />} />
        <Route path="admin/vip" element={<AdminVipPage />} />
        <Route path="admin/clone" element={<AdminClonePage />} />
        <Route path="admin/close" element={<AdminClosePage />} />
        <Route path="admin/owner" element={<AdminOwnerPage />} />
        <Route path="admin/products-csv" element={<AdminProductsCsvPage />} />
        <Route path="admin/broadcast" element={<AdminBroadcastPage />} />
        <Route path="admin/disclaimer" element={<AdminDisclaimerPage />} />
        <Route path="admin/unpaid" element={<AdminUnpaidPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
  if (!isWebMode()) return routes;
  return (
    <>
      <WebTopBar />
      {routes}
      <WebMainButton />
    </>
  );
}

export function App(): React.JSX.Element {
  const appearance = useAppearance();
  useAppearanceChrome(appearance);
  // Changing the language redraws every screen (same page, same session).
  const [language, setLanguage] = useState(lang());
  useEffect(() => onLangChange(setLanguage), []);

  return (
    <AppRoot
      appearance={appearance}
      platform={platform()}
      className={appearance === 'dark' ? 'tma-root tma-dark' : 'tma-root'}
    >
      <SessionProvider>
        <HashRouter key={language}>
          <Shell />
        </HashRouter>
      </SessionProvider>
    </AppRoot>
  );
}
