import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { isSaleStatus, type ExportRequest, type ExportScope, type Order } from '@tma-shop/shared';
import { api, ApiClientError } from '../../api/client.js';
import { decryptAddress, loadPrivateKey } from '../../lib/addressCrypto.js';
import { shareOrDownload, toCsv } from '../../lib/download.js';
import { copyText } from '../../lib/clipboard.js';
import { itemName } from '../../lib/variants.js';
import { useShop } from '../../providers/ShopProvider.js';
import { askWriteAccess } from '../../lib/writeAccess.js';
import { isWebMode, saveBase64File } from '../../lib/web.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { locale, t, tn, type MessageKey } from '../../i18n/index.js';

const SCOPES: Array<{ key: ExportScope; label: MessageKey }> = [
  { key: 'paid', label: 'export.paid' },
  { key: 'toFulfil', label: 'filter.toShip' },
  { key: 'shipped', label: 'orderStatus.shipped' },
  { key: 'fulfilled', label: 'orderStatus.fulfilled' },
  { key: 'unpaid', label: 'filter.unpaid' },
  { key: 'all', label: 'catalog.all' },
];

type Period = 'all' | 'thisMonth' | 'lastMonth';
const PERIODS: Array<{ key: Period; label: MessageKey }> = [
  { key: 'all', label: 'export.allTime' },
  { key: 'thisMonth', label: 'export.thisMonth' },
  { key: 'lastMonth', label: 'export.lastMonth' },
];

/** [from, to) of a period in local time, as ISO instants. */
function periodRange(period: Period): { from?: string; to?: string } {
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === 'thisMonth') return { from: thisMonth.toISOString() };
  if (period === 'lastMonth') {
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { from: lastMonth.toISOString(), to: thisMonth.toISOString() };
  }
  return {};
}

function inScope(order: Order, scope: ExportScope): boolean {
  switch (scope) {
    case 'paid':
      return isSaleStatus(order.status);
    case 'toFulfil':
      return order.status === 'paid';
    case 'shipped':
      return order.status === 'shipped';
    case 'fulfilled':
      return order.status === 'fulfilled';
    case 'unpaid':
      return order.status === 'pending' || order.status === 'awaiting_payment';
    case 'cancelled':
      return order.status === 'cancelled';
    case 'all':
      return true;
  }
}

/** Addresses shown at a time when unfolded. */
const PAGE_SIZE = 20;

interface ShippingEntry {
  id: string;
  title: string;
  /** The address as it goes on a label. */
  text: string;
  items: string;
}

interface ShippingList {
  fileName: string;
  csv: string;
  entries: ShippingEntry[];
  failed: number;
}

/** Whether the device can hand files to other apps (phones' share sheet). */
function canShareFiles(): boolean {
  try {
    const probe = new File(['x'], 'x.csv', { type: 'text/csv' });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** Reports sent by the bot to the admin's chat, plus a shipping list made on this device. */
export function AdminExportPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminExport />
    </AdminOnly>
  );
}

function AdminExport(): React.JSX.Element {
  const { shop } = useShop();
  const [params] = useSearchParams();
  const initialScope = SCOPES.find((s) => s.key === params.get('scope'))?.key ?? 'paid';
  const [scope, setScope] = useState<ExportScope>(initialScope);
  const [period, setPeriod] = useState<Period>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The shipping list, shown here too: Telegram's in-app browser often cannot
  // save files, so it can always be copied from the screen.
  const [list, setList] = useState<ShippingList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Addresses stay folded: a long list would fill the screen.
  const [showAddresses, setShowAddresses] = useState(false);
  const [shown, setShown] = useState(PAGE_SIZE);
  const actions = useAdminActions(() => undefined);

  const send = async (format: ExportRequest['format']): Promise<void> => {
    setBusy(format);
    setMessage(null);
    setError(null);
    try {
      // The bot can only send the file if it may message this admin.
      await askWriteAccess();
      const result = await api.adminExport({
        format,
        scope,
        ...periodRange(period),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const orders = tn(result.orders, 'count.orders.one', 'count.orders.other');
      if (result.file) {
        saveBase64File(result.file);
        setMessage(t('export.downloaded', { orders }));
      } else {
        setMessage(t('export.sent', { orders }));
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t('export.failed'));
    } finally {
      setBusy(null);
    }
  };

  /** Shipping list: addresses are decrypted here, never on the server. */
  const shippingList = async (): Promise<void> => {
    setBusy('shipping');
    setList(null);
    setShowAddresses(false);
    setListError(null);
    setCopied(null);
    try {
      const privateKey = loadPrivateKey(shop.id);
      if (!privateKey) {
        setListError(t('export.needKey'));
        return;
      }
      const { from, to } = periodRange(period);
      const orders = (await api.adminGetOrders()).filter(
        (o) =>
          o.encryptedAddress &&
          inScope(o, scope) &&
          (!from || o.createdAt >= from) &&
          (!to || o.createdAt < to),
      );
      if (orders.length === 0) {
        setListError(t('export.noAddresses'));
        return;
      }
      const entries: ShippingEntry[] = [];
      const rows: Array<Array<string | number>> = [
        [
          t('csv.order'),
          t('csv.date'),
          t('csv.username'),
          t('csv.zone'),
          t('csv.name'),
          t('csv.address'),
          t('csv.address2'),
          t('csv.postalCode'),
          t('csv.city'),
          t('csv.region'),
          t('csv.country'),
          t('csv.phone'),
          t('csv.notes'),
          t('csv.items'),
        ],
      ];
      let failed = 0;
      for (const o of orders) {
        try {
          const a = await decryptAddress(o.encryptedAddress ?? '', privateKey);
          const items = o.items.map((i) => `${i.quantity}× ${itemName(i)}`).join(', ');
          entries.push({
            id: o.id,
            title: `#${o.id.slice(0, 8)}${o.contactUsername ? ` · @${o.contactUsername}` : ''}`,
            text: [
              a.name,
              a.line1,
              a.line2,
              [a.postalCode, a.city].filter(Boolean).join(' '),
              [a.region, a.country].filter(Boolean).join(', '),
              a.phone,
              a.notes,
            ]
              .filter((line) => line && line.trim() !== '')
              .join('\n'),
            items,
          });
          rows.push([
            `#${o.id.slice(0, 8)}`,
            new Date(o.createdAt).toLocaleString(locale()),
            o.contactUsername ? `@${o.contactUsername}` : '',
            o.shippingZoneName ?? '',
            a.name,
            a.line1,
            a.line2,
            a.postalCode,
            a.city,
            a.region,
            a.country,
            a.phone,
            a.notes,
            o.items.map((i) => `${i.quantity}× ${itemName(i)}`).join(', '),
          ]);
        } catch {
          failed += 1;
        }
      }
      const date = new Date().toISOString().slice(0, 10);
      const next: ShippingList = {
        fileName: `${shop.slug}-shipping-${date}.csv`,
        csv: toCsv(rows),
        entries,
        failed,
      };
      setList(next);
      // On phones this opens the share sheet (save, send by Telegram, open in Excel…).
      if (canShareFiles()) await shareOrDownload(next.fileName, next.csv);
    } catch (err) {
      setListError(err instanceof Error ? err.message : t('export.saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (key: string, text: string): Promise<void> => {
    setCopied((await copyText(text)) ? key : null);
  };

  const allText = (l: ShippingList): string =>
    l.entries.map((e) => `${e.title}\n${e.text}\n${e.items}`).join('\n\n');

  return (
    <List>
      <PageTitle title={t('adminHome.export')} />
      <ErrorBanner message={error} />
      {message && (
        <Section>
          <Cell multiline>{message}</Cell>
        </Section>
      )}

      <Section header={t('adminHome.orders')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
          {SCOPES.map((s) => (
            <Button
              key={s.key}
              size="s"
              mode={s.key === scope ? 'filled' : 'bezeled'}
              onClick={() => setScope(s.key)}
            >
              {t(s.label)}
            </Button>
          ))}
        </div>
      </Section>
      <Section header={t('export.period')}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
          {PERIODS.map((p) => (
            <Button
              key={p.key}
              size="s"
              mode={p.key === period ? 'filled' : 'bezeled'}
              onClick={() => setPeriod(p.key)}
            >
              {t(p.label)}
            </Button>
          ))}
        </div>
      </Section>

      <Section
        header={t(isWebMode() ? 'export.toChatWeb' : 'export.toChat')}
        footer={t(isWebMode() ? 'export.toChatFooterWeb' : 'export.toChatFooter')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Button stretched loading={busy === 'xlsx'} onClick={() => void send('xlsx')}>
            {t('export.excel')}
          </Button>
          <Button
            stretched
            mode="bezeled"
            loading={busy === 'csv-orders'}
            onClick={() => void send('csv-orders')}
          >
            {t('export.csvOrders')}
          </Button>
          <Button
            stretched
            mode="bezeled"
            loading={busy === 'csv-lines'}
            onClick={() => void send('csv-lines')}
          >
            {t('export.csvLines')}
          </Button>
        </div>
      </Section>

      <Section
        header={t('export.shippingList')}
        footer={t('export.shippingListFooter')}
      >
        <div style={{ padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            loading={busy === 'shipping'}
            onClick={() => void shippingList()}
          >
            {t('export.shippingButton')}
          </Button>
        </div>
        {listError && (
          <Cell multiline style={{ color: 'var(--tgui--destructive_text_color)' }}>
            {listError}
          </Cell>
        )}
      </Section>

      {list && (
        <>
          <Section footer={list.failed > 0 ? t('export.needOtherKey', { count: list.failed }) : undefined}>
            <Cell multiline>
              <strong>{t('export.listReady', { count: list.entries.length })}</strong>
            </Cell>
          </Section>

          <Section header={t('export.safeTitle')} footer={t('export.safeFooter')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
              <Button stretched onClick={() => void copy('csv', list.csv)}>
                {copied === 'csv' ? t('common.copied') : t('export.copyCsv')}
              </Button>
              <Button stretched mode="bezeled" onClick={() => void copy('text', allText(list))}>
                {copied === 'text' ? t('common.copied') : t('export.copyText')}
              </Button>
              <Button
                stretched
                mode="bezeled"
                onClick={() =>
                  void shareOrDownload(list.fileName, list.csv).then((result) => {
                    if (result === 'failed') setListError(t('export.saveFailed'));
                  })
                }
              >
                {t('export.saveFile')}
              </Button>
            </div>
          </Section>

          {!isWebMode() && (
            <Section header={t('export.lessSafeTitle')} footer={t('export.lessSafeFooter')}>
              <div style={{ padding: 16 }}>
                <Button
                  stretched
                  mode="bezeled"
                  loading={busy === 'send-list'}
                  onClick={() =>
                    void actions.twoTap('send-list', async () => {
                      setBusy('send-list');
                      try {
                        await askWriteAccess();
                        await api.adminSendShippingList(
                          list.fileName,
                          list.csv,
                          list.entries.length,
                        );
                        setCopied('sent');
                      } catch (err) {
                        setListError(
                          err instanceof ApiClientError ? err.message : t('export.failed'),
                        );
                      } finally {
                        setBusy(null);
                      }
                    })
                  }
                >
                  {copied === 'sent'
                    ? t('export.sentToChat')
                    : actions.tapLabel(
                        'send-list',
                        t('export.sendToBot'),
                        t('export.sendToBotConfirm'),
                      )}
                </Button>
              </div>
            </Section>
          )}
          <Section>
            <Cell
              onClick={() => {
                setShowAddresses((v) => !v);
                setShown(PAGE_SIZE);
              }}
              after={showAddresses ? '▲' : '▼'}
            >
              {showAddresses
                ? t('export.hideAddresses')
                : t('export.showAddresses', { count: list.entries.length })}
            </Cell>
            {showAddresses &&
              list.entries.slice(0, shown).map((e) => (
                <Cell
                  key={e.id}
                  multiline
                  subtitle={e.items}
                  description={<span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span>}
                  after={
                    <Button size="s" mode="bezeled" onClick={() => void copy(e.id, e.text)}>
                      {copied === e.id ? t('common.copied') : t('common.copy')}
                    </Button>
                  }
                >
                  {e.title}
                </Cell>
              ))}
            {showAddresses && shown < list.entries.length && (
              <Cell onClick={() => setShown((n) => n + PAGE_SIZE)}>
                {t('export.showMore', { count: Math.min(PAGE_SIZE, list.entries.length - shown) })}
              </Cell>
            )}
          </Section>
        </>
      )}
    </List>
  );
}
