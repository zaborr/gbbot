import { useEffect, useRef, useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import type { Order } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { Input } from './Field.js';
import { formatDateTime } from '../lib/format.js';
import { t, tn } from '../i18n/index.js';

/** What a label may be (as the server takes it). */
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

const errorText = (err: unknown): string => (err instanceof ApiClientError ? err.message : t('error.title'));

/** Whether an order is waiting for its customer's label. */
export const labelMissing = (order: Order): boolean => order.label !== null && order.label.receivedAt === null;

/** The customer: the label the organisers asked for, sent from the phone. */
export function CustomerLabelSection({ order, onSent }: { order: Order; onSent: () => void }): React.JSX.Element | null {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const label = order.label;
  if (!label || order.status === 'cancelled') return null;

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (!TYPES.includes(file.type) || file.size > MAX_BYTES) {
      setNote({ text: t('label.badFile'), bad: true });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await api.uploadOrderLabel(order.id, file);
      setNote({ text: t('label.sent'), bad: false });
      onSent();
    } catch (err) {
      setNote({ text: errorText(err), bad: true });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Section header={t('label.title')} footer={note?.text ?? t('label.customerFooter')}>
      <Cell multiline subtitle={label.note ?? undefined}>
        {label.receivedAt
          ? t('label.customerReceived', { date: formatDateTime(label.receivedAt) })
          : t('label.customerAsked')}
      </Cell>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/*"
        style={{ display: 'none' }}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <div style={{ padding: 16 }}>
        <Button
          stretched
          mode={label.receivedAt ? 'bezeled' : 'filled'}
          loading={busy}
          onClick={() => input.current?.click()}
        >
          {label.receivedAt ? t('label.uploadAgain') : t('label.upload')}
        </Button>
      </div>
    </Section>
  );
}

/** The organisers, in an order: ask for its label, look at it, have the bot send it. */
export function AdminLabelSection({ order, onChanged }: { order: Order; onChanged: () => void }): React.JSX.Element | null {
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [open, setOpen] = useState<{ url: string; type: string; name: string } | null>(null);
  useEffect(() => () => (open ? URL.revokeObjectURL(open.url) : undefined), [open]);
  if (order.status === 'cancelled' || order.userId === null) return null;
  const label = order.label;

  const run = (key: string, work: () => Promise<void>): void => {
    setBusy(key);
    setNote(null);
    void work()
      .catch((err: unknown) => setNote({ text: errorText(err), bad: true }))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <Section header={t('label.title')} footer={note?.text ?? t('label.adminFooter')}>
        {label && (
          <Cell multiline subtitle={label.note ?? undefined}>
            {label.receivedAt
              ? t('label.adminReceived', { date: formatDateTime(label.receivedAt) })
              : t('label.adminAsked', { date: formatDateTime(label.requestedAt) })}
          </Cell>
        )}
        {label?.receivedAt && (
          <div style={{ display: 'flex', gap: 8, padding: '8px 16px' }}>
            <Button
              size="s"
              mode="bezeled"
              loading={busy === 'view'}
              onClick={() =>
                run('view', async () => {
                  const blob = await api.adminLabelFile(order.id);
                  setOpen({ url: URL.createObjectURL(blob), type: blob.type, name: label.fileName ?? '' });
                })
              }
            >
              {t('label.view')}
            </Button>
            <Button
              size="s"
              mode="bezeled"
              loading={busy === 'send'}
              onClick={() =>
                run('send', async () => {
                  await api.adminSendLabel(order.id);
                  setNote({ text: t('label.sentToYou'), bad: false });
                })
              }
            >
              {t('label.sendToMe')}
            </Button>
          </div>
        )}
        {asking ? (
          <>
            <Input
              header={t('label.noteField')}
              placeholder={t('label.notePlaceholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, padding: 16 }}>
              <Button stretched mode="bezeled" onClick={() => setAsking(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                stretched
                loading={busy === 'ask'}
                onClick={() =>
                  run('ask', async () => {
                    await api.adminRequestLabel(order.id, text.trim() || null);
                    setAsking(false);
                    setText('');
                    setNote({ text: t('label.askedDone'), bad: false });
                    onChanged();
                  })
                }
              >
                {t('label.askSend')}
              </Button>
            </div>
          </>
        ) : (
          <div style={{ padding: 16 }}>
            <Button stretched mode="bezeled" onClick={() => setAsking(true)}>
              {label ? t('label.askAgain') : t('label.ask')}
            </Button>
          </div>
        )}
      </Section>
      {open && (
        <div className="gb-file-view" role="dialog" aria-label={open.name}>
          <div className="gb-file-view-bar">
            <span>{open.name}</span>
            <Button size="s" mode="bezeled" onClick={() => setOpen(null)}>
              {t('reports.close')}
            </Button>
          </div>
          {open.type.startsWith('image/') ? <img src={open.url} alt={open.name} /> : <iframe src={open.url} title={open.name} />}
        </div>
      )}
    </>
  );
}

/** The organisers, in the orders list: ask every paid order without its label (of a zone, or all). */
export function LabelRequestsSection({ orders, onDone }: { orders: Order[]; onDone: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [zone, setZone] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const zones = [...new Set(orders.map((o) => o.shippingZoneName).filter((z): z is string => Boolean(z)))].sort();

  useEffect(() => {
    if (!open) return;
    setCount(null);
    void api
      .adminRequestLabels({ zone, note: null, dryRun: true })
      .then((r) => setCount(r.count))
      .catch((err: unknown) => setNote({ text: errorText(err), bad: true }));
  }, [open, zone]);

  if (!open) {
    return (
      <Section>
        <Cell onClick={() => setOpen(true)}>{t('label.bulkOpen')}</Cell>
      </Section>
    );
  }
  return (
    <Section header={t('label.bulkTitle')} footer={note?.text ?? t('label.bulkFooter')}>
      {zones.length > 0 && (
        <div className="gb-tabs" role="tablist" style={{ padding: '8px 16px' }}>
          <Button size="s" mode={zone === null ? 'filled' : 'bezeled'} onClick={() => setZone(null)}>
            {t('label.allZones')}
          </Button>
          {zones.map((z) => (
            <Button key={z} size="s" mode={zone === z ? 'filled' : 'bezeled'} onClick={() => setZone(z)}>
              {z}
            </Button>
          ))}
        </div>
      )}
      <Input
        header={t('label.noteField')}
        placeholder={t('label.notePlaceholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Cell multiline>
        {count === null ? '…' : tn(count, 'label.bulkCount.one', 'label.bulkCount.other')}
      </Cell>
      <div style={{ display: 'flex', gap: 8, padding: 16 }}>
        <Button stretched mode="bezeled" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
        <Button
          stretched
          disabled={!count}
          loading={busy}
          onClick={() => {
            setBusy(true);
            setNote(null);
            void api
              .adminRequestLabels({ zone, note: text.trim() || null, dryRun: false })
              .then((r) => {
                setNote({ text: tn(r.sent, 'label.bulkSent.one', 'label.bulkSent.other'), bad: false });
                setText('');
                onDone();
              })
              .catch((err: unknown) => setNote({ text: errorText(err), bad: true }))
              .finally(() => setBusy(false));
          }}
        >
          {t('label.askSend')}
        </Button>
      </div>
    </Section>
  );
}
