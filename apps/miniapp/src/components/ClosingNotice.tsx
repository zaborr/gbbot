import { Cell, Section } from '@telegram-apps/telegram-ui';
import type { ShopConfig } from '@tma-shop/shared';
import { locale, t } from '../i18n/index.js';

/** "20 Oct, 23:59" in the user's language. */
export function closingDate(iso: string): string {
  return new Date(iso).toLocaleString(locale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Whether the scheduled closing is near enough for the big notice (within the
 * GB's `closingWarnHours`). Before that, only a short line is shown.
 */
export function closingSoon(shop: ShopConfig, now = Date.now()): boolean {
  if (!shop.closesAt) return false;
  return new Date(shop.closesAt).getTime() - now <= shop.closingWarnHours * 3_600_000;
}

/**
 * At the top of the catalog: the GB is closed (orders can still be looked at),
 * or it closes soon.
 */
export function ClosingNotice({ shop }: { shop: ShopConfig }): React.JSX.Element | null {
  if (shop.isClosed) {
    return (
      <Section>
        <Cell
          className="tma-notice"
          before={<span style={{ fontSize: 22 }}>🔒</span>}
          subtitle={t('closed.hint')}
          multiline
        >
          {t('closed.title')}
        </Cell>
      </Section>
    );
  }
  if (!shop.closesAt || !closingSoon(shop)) return null;
  return (
    <Section>
      <Cell
        className="tma-notice"
        before={<span style={{ fontSize: 22 }}>⏳</span>}
        subtitle={t('closing.hint')}
        multiline
      >
        {t('closing.title', { date: closingDate(shop.closesAt) })}
      </Cell>
    </Section>
  );
}
