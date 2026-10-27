import { useNavigate } from 'react-router-dom';
import { Badge, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { AdminOnly, isSale, needsAttention, toMajor } from './common.js';
import { useShop, useShopPath } from '../../providers/ShopProvider.js';
import { closingDate } from '../../components/ClosingNotice.js';
import { t, tn } from '../../i18n/index.js';

/**
 * Admin menu, from what is used every day to what is rarely touched: orders,
 * customers, catalog, payments, shipping, the GB itself and (for its owner)
 * who runs it. Each line shows its state; problems go to the top.
 */
export function AdminHomePage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminHome />
    </AdminOnly>
  );
}

const warning: React.CSSProperties = { color: 'var(--tgui--destructive_text_color)' };

function AdminHome(): React.JSX.Element {
  const navigate = useNavigate();
  const to = useShopPath();
  const orders = useAsync(() => api.adminGetOrders(), []);
  const products = useAsync(() => api.adminGetProducts(), []);
  const { shop: config } = useShop();
  const go = (path: string) => () => navigate(to(path));

  const all = orders.data ?? [];
  const toReview = all.filter(needsAttention).length;
  const sales = all.filter(isSale).length;
  const fee = config.orderFee;
  const activeZones = config.shippingZones.filter((z) => z.isActive).length;
  const payOptions = config.paymentMethods.length + config.manualMethods.length;
  const missingKey = activeZones > 0 && !config.addressPublicKey;

  const openState = config.isClosed
    ? t('closed.title')
    : config.closesAt
      ? t('closing.title', { date: closingDate(config.closesAt) })
      : t('adminHome.closeOpen');
  const visibility = !config.isVisible
    ? t('adminHome.stateHidden')
    : config.vipOnly
      ? t('adminHome.stateVip')
      : t('adminHome.stateVisible');

  return (
    <List>
      {/* State at a glance, and what needs doing first. */}
      <Section>
        <Cell
          onClick={config.canOwn ? go('/admin/owner?section=team') : go('/admin/close')}
          subtitle={visibility}
          multiline
        >
          <strong>{config.name}</strong> · {openState}
        </Cell>
        {toReview > 0 && (
          <Cell onClick={go('/admin/orders?filter=attention')} multiline>
            {tn(toReview, 'adminHome.warnReview.one', 'adminHome.warnReview.other')}
          </Cell>
        )}
        {payOptions === 0 && (
          <Cell onClick={go('/admin/wallets')} multiline style={warning}>
            {t('adminHome.warnNoPay')}
          </Cell>
        )}
        {missingKey && (
          <Cell onClick={go('/admin/address-key')} multiline style={warning}>
            {t('adminHome.warnNoKey')}
          </Cell>
        )}
      </Section>

      <Section header={t('adminHome.orders')}>
        <Cell
          onClick={go('/admin/orders?filter=attention')}
          subtitle={t('adminHome.toReviewHint')}
          after={toReview > 0 ? <Badge type="number">{toReview}</Badge> : undefined}
        >
          {t('adminHome.toReview')}
        </Cell>
        <Cell
          onClick={go('/admin/orders')}
          subtitle={orders.data ? tn(all.length, 'count.orders.one', 'count.orders.other') : t('common.loading')}
        >
          {t('adminHome.allOrders')}
        </Cell>
        <Cell
          onClick={go('/admin/summary')}
          subtitle={orders.data ? tn(sales, 'count.paidOrders.one', 'count.paidOrders.other') : t('common.loading')}
        >
          {t('adminHome.summary')}
        </Cell>
        <Cell onClick={go('/admin/export')} subtitle={t('adminHome.exportHint')}>
          {t('adminHome.export')}
        </Cell>
      </Section>

      <Section header={t('adminHome.customers')}>
        <Cell onClick={go('/admin/broadcast')} subtitle={t('broadcast.hint')}>
          {t('broadcast.title')}
        </Cell>
        <Cell
          onClick={go('/admin/disclaimer')}
          subtitle={config.disclaimer ? t('disclaimerAdmin.on') : t('disclaimerAdmin.off')}
        >
          {t('disclaimerAdmin.menu')}
        </Cell>
        <Cell
          onClick={go('/admin/vip')}
          subtitle={config.vipOnly ? t('adminHome.vipOnlyShop') : t('adminHome.vipHint')}
        >
          {t('adminHome.vip')}
        </Cell>
        {config.canOwn && (
          <Cell onClick={go('/admin/blacklist')} subtitle={t('blacklist.hint')}>
            {t('blacklist.title')}
          </Cell>
        )}
      </Section>

      <Section header={t('catalog.title')}>
        <Cell
          onClick={go('/admin/catalog')}
          subtitle={
            products.data
              ? tn(products.data.length, 'count.products.one', 'count.products.other')
              : t('common.loading')
          }
        >
          {t('adminHome.catalog')}
        </Cell>
        <Cell onClick={go('/admin/products/new')}>{t('adminHome.newProduct')}</Cell>
      </Section>

      <Section header={t('adminHome.payments')}>
        <Cell
          onClick={go('/admin/wallets')}
          subtitle={
            payOptions > 0
              ? tn(payOptions, 'count.paymentOptions.one', 'count.paymentOptions.other')
              : t('adminHome.noWallets')
          }
        >
          {t('adminHome.wallets')}
        </Cell>
        <Cell
          onClick={go('/admin/fee')}
          subtitle={
            fee > 0
              ? t('adminHome.feeOn', { label: config.orderFeeLabel, amount: toMajor(fee) }) +
                (config.vipNoFee ? t('adminHome.feeVipFree') : '')
              : t('common.off')
          }
        >
          {t('adminHome.fee')}
        </Cell>
        <Cell
          onClick={go('/admin/unpaid')}
          subtitle={
            config.autoCancelHours > 0
              ? t('adminHome.unpaidOn', { hours: config.autoCancelHours })
              : t('adminHome.unpaidOff')
          }
        >
          {t('adminHome.unpaid')}
        </Cell>
      </Section>

      <Section header={t('adminHome.shippingSection')}>
        <Cell
          onClick={go('/admin/shipping')}
          subtitle={
            activeZones > 0
              ? tn(activeZones, 'count.zones.one', 'count.zones.other')
              : t('adminHome.shippingOff')
          }
        >
          {t('adminHome.shipping')}
        </Cell>
        <Cell
          onClick={go('/admin/address-key')}
          subtitle={
            config.addressKeyFingerprint
              ? t('adminHome.keyId', { id: config.addressKeyFingerprint })
              : missingKey
                ? t('adminHome.keyMissing')
                : t('common.notSet')
          }
          style={missingKey ? warning : undefined}
        >
          {t('adminHome.addressKey')}
        </Cell>
        {activeZones > 0 && (
          <Cell onClick={go('/admin/shipping-list')} subtitle={t('adminHome.shippingListHint')}>
            {t('adminHome.shippingList')}
          </Cell>
        )}
      </Section>

      <Section header={t('adminHome.gb')}>
        <Cell onClick={go('/admin/settings')} subtitle={config.name}>
          {t('adminHome.profile')}
        </Cell>
        <Cell onClick={go('/admin/close')} subtitle={openState}>
          {t('adminHome.close')}
        </Cell>
        <Cell
          onClick={go('/admin/goal')}
          subtitle={
            config.goal
              ? t('adminHome.goalOn', { percent: config.goal.paidPercent })
              : t('common.off')
          }
        >
          {t('adminHome.goal')}
        </Cell>
      </Section>

      {config.canOwn && (
        <Section header={t('adminHome.ownerSection')}>
          <Cell onClick={go('/admin/owner?section=team')} subtitle={visibility}>
            {t('adminHome.ownerTeam')}
          </Cell>
          <Cell onClick={go('/admin/owner?section=duplicate')} subtitle={t('adminHome.duplicateHint')}>
            {t('adminHome.duplicate')}
          </Cell>
          <Cell onClick={go('/admin/owner?section=backup')} subtitle={t('adminHome.backupHint')}>
            {t('adminHome.backup')}
          </Cell>
          <Cell onClick={go('/admin/owner?section=delete')}>
            <span style={warning}>{t('adminHome.ownerDelete')}</span>
          </Cell>
        </Section>
      )}
    </List>
  );
}
