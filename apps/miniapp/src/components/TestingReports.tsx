import { useEffect, useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import type { TestingReportView } from '@tma-shop/shared';
import { api, ApiClientError, type ReportScope } from '../api/client.js';
import { formatDateTime } from '../lib/format.js';
import { t } from '../i18n/index.js';

/**
 * Lab reports kept: each with what it is about, and two ways to have it —
 * open it here (when a copy is kept) or have the bot send it to one's chat.
 */
export function TestingReports({
  reports,
  scope,
  header,
  footer,
  showShop = false,
}: {
  reports: TestingReportView[];
  scope: ReportScope;
  header?: string;
  footer?: string;
  /** The platform list: which GB each one is from. */
  showShop?: boolean;
}): React.JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; bad: boolean } | null>(null);
  const [open, setOpen] = useState<{ url: string; type: string; name: string } | null>(null);

  // The opened file's address goes when it is closed.
  useEffect(() => () => (open ? URL.revokeObjectURL(open.url) : undefined), [open]);

  if (reports.length === 0) return null;

  const view = (r: TestingReportView): void => {
    setBusy(`view-${r.id}`);
    setNote(null);
    void api
      .testingReportFile(scope, r.id)
      .then((blob) =>
        setOpen({ url: URL.createObjectURL(blob), type: blob.type, name: r.fileName ?? `${r.product} · ${r.lab}` }),
      )
      .catch((err: unknown) =>
        setNote({ id: r.id, text: err instanceof ApiClientError ? err.message : t('error.title'), bad: true }),
      )
      .finally(() => setBusy(null));
  };

  const send = (r: TestingReportView): void => {
    setBusy(`send-${r.id}`);
    setNote(null);
    void api
      .sendTestingReport(scope, r.id)
      .then(() => setNote({ id: r.id, text: t('reports.sent'), bad: false }))
      .catch((err: unknown) =>
        setNote({ id: r.id, text: err instanceof ApiClientError ? err.message : t('error.title'), bad: true }),
      )
      .finally(() => setBusy(null));
  };

  return (
    <>
      <Section header={header} footer={footer}>
        {reports.map((r) => (
          <div key={r.id}>
            <Cell
              multiline
              subtitle={[
                showShop ? r.shopName : null,
                r.lab,
                r.tiers.length > 0 ? r.tiers.join(', ') : null,
                formatDateTime(r.createdAt),
                scope !== 'mine' ? t('reports.delivered', { count: r.delivered }) : null,
                scope !== 'mine' && r.uploadedBy ? t('reports.by', { who: r.uploadedBy }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {r.kind === 'extra' ? t('reports.extraOf', { product: r.product }) : r.product}
            </Cell>
            <div className="gb-donation-row" style={{ padding: '0 16px 12px', gap: 8 }}>
              {r.hasCopy && (
                <Button size="s" mode="bezeled" loading={busy === `view-${r.id}`} onClick={() => view(r)}>
                  {t('reports.view')}
                </Button>
              )}
              <Button size="s" mode="bezeled" loading={busy === `send-${r.id}`} onClick={() => send(r)}>
                {t('reports.send')}
              </Button>
            </div>
            {note?.id === r.id && (
              <Cell multiline>
                <span style={{ color: note.bad ? 'var(--tgui--destructive_text_color)' : undefined }}>{note.text}</span>
              </Cell>
            )}
          </div>
        ))}
      </Section>
      {open && (
        <div className="gb-file-view" role="dialog" aria-label={open.name}>
          <div className="gb-file-view-bar">
            <span>{open.name}</span>
            <Button size="s" mode="bezeled" onClick={() => setOpen(null)}>
              {t('reports.close')}
            </Button>
          </div>
          {open.type.startsWith('image/') ? (
            <img src={open.url} alt={open.name} />
          ) : (
            <iframe src={open.url} title={open.name} />
          )}
        </div>
      )}
    </>
  );
}
