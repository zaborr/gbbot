import { useState } from 'react';
import { Button, Cell, Section, Switch } from '@telegram-apps/telegram-ui';
import type { Order } from '@tma-shop/shared';
import { copyText } from '../lib/clipboard.js';
import { decryptAddresses, orderRows, toTsv, type CellValue } from '../lib/orderSheet.js';
import { useShop } from '../providers/ShopProvider.js';
import { t } from '../i18n/index.js';

/**
 * "📋 Copy": the orders as a table for Excel / Google Sheets. One order
 * carries its address when this device can read it; for several, the shipping
 * data is only added when asked (so dozens of addresses are not copied by mistake).
 */
export function CopyOrders({
  orders,
  several,
  before,
}: {
  orders: readonly Order[];
  /** A list (toggle for shipping data) rather than a single order. */
  several: boolean;
  /** Rows to put above the orders (e.g. the summary's totals). */
  before?: CellValue[][];
}): React.JSX.Element | null {
  const { shop } = useShop();
  const [withShipping, setWithShipping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const hasAddresses = orders.some((o) => o.encryptedAddress);
  if (orders.length === 0) return null;

  const copy = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    const addressesWanted = hasAddresses && (!several || withShipping);
    const { addresses, missing } = addressesWanted
      ? await decryptAddresses(orders, shop.id)
      : { addresses: undefined, missing: 0 };
    const rows = orderRows(orders, shop.orderFeeLabel, addresses);
    const tsv = toTsv(before ? [...before, [], ...rows] : rows);
    const ok = await copyText(tsv);
    setResult(
      !ok
        ? t('sheet.copyFailed')
        : missing > 0
          ? t('sheet.copiedNoAddress', { count: missing })
          : t('sheet.copied'),
    );
    setBusy(false);
  };

  return (
    <Section footer={result ?? t('sheet.footer')}>
      {several && hasAddresses && (
        <Cell
          Component="label"
          after={
            <Switch
              checked={withShipping}
              onChange={(e) => {
                setWithShipping(e.target.checked);
                setResult(null);
              }}
            />
          }
          multiline
        >
          {t('sheet.withShipping')}
        </Cell>
      )}
      <div style={{ padding: 16 }}>
        <Button stretched mode="bezeled" loading={busy} onClick={() => void copy()}>
          {t('sheet.copy')}
        </Button>
      </div>
    </Section>
  );
}
