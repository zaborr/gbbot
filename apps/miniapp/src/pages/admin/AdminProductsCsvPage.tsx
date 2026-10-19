import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { CsvIssue, ProductsCsvPreview, ProductsCsvResult } from '@tma-shop/shared';
import { Textarea } from '../../components/Field.js';
import { api } from '../../api/client.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t, type MessageKey } from '../../i18n/index.js';

/** Products as CSV: export through the bot; import with a preview first. */
export function AdminProductsCsvPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <ProductsCsv />
    </AdminOnly>
  );
}

const danger: React.CSSProperties = { color: 'var(--tgui--destructive_text_color)' };

/** Problems the API reports, each with its own text. */
const ISSUE_CODES = [
  'missing_column',
  'unknown_columns',
  'empty',
  'too_many_rows',
  'no_slug',
  'bad_slug',
  'no_title',
  'no_price',
  'bad_price',
  'bad_currency',
  'bad_active',
  'bad_url',
  'bad_tiers',
  'bad_stock',
  'missing_value',
  'repeated_product',
  'invalid',
] as const;

/** "Line 3: …" */
function issueText(issue: CsvIssue): string {
  const known = (ISSUE_CODES as readonly string[]).includes(issue.code);
  const text = known
    ? t(`csv.err.${issue.code}` as MessageKey, issue.vars)
    : t('csv.err.invalid', { message: issue.code });
  return t('csv.line', { line: issue.line, text });
}

function ProductsCsv(): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [sent, setSent] = useState(false);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProductsCsvPreview | null>(null);
  const [result, setResult] = useState<ProductsCsvResult | null>(null);
  const [busy, setBusy] = useState<'export' | 'preview' | 'import' | null>(null);
  // Opened from the bot ("Open to import"): the file sent to it, checked straight away.
  const [params] = useSearchParams();
  const uploadId = params.get('upload');
  useEffect(() => {
    if (!uploadId) return;
    void actions.run(async () => {
      const upload = await api.getUpload(uploadId);
      setFileName(upload.fileName);
      setCsv(upload.content);
      setPreview(await api.adminPreviewProductsCsv(upload.content));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId]);

  const run = async (kind: 'export' | 'preview' | 'import', action: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    await actions.run(action);
    setBusy(null);
  };

  const changeText = (value: string): void => {
    setCsv(value);
    setPreview(null);
    setResult(null);
  };

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setFileName(file.name);
    changeText(await file.text());
  };

  const creates = preview?.products.filter((p) => p.action === 'create').length ?? 0;
  const updates = preview?.products.filter((p) => p.action === 'update').length ?? 0;

  return (
    <List>
      <PageTitle title={t('csv.title')} />
      <ErrorBanner message={actions.error} />

      <Section header={t('csv.exportTitle')} footer={t('csv.exportFooter')}>
        <div style={{ padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            loading={busy === 'export'}
            onClick={() =>
              void run('export', async () => {
                await api.adminExportProductsCsv();
                setSent(true);
              })
            }
          >
            {t('csv.export')}
          </Button>
        </div>
        {sent && <Cell multiline>{t('csv.sent')}</Cell>}
      </Section>

      <Section header={t('csv.importTitle')} footer={`${t('csv.importFooter')} ${t('csv.importFooterBot')}`}>
        <div style={{ padding: '12px 16px' }}>
          <label style={{ display: 'block' }}>
            <span className="tma-field-label" style={{ padding: 0 }}>
              {fileName ?? t('csv.chooseFile')}
            </span>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => void pickFile(e.target.files?.[0])}
              style={{ marginTop: 8, maxWidth: '100%' }}
            />
          </label>
        </div>
        <Textarea
          header={t('csv.paste')}
          placeholder="producto;titulo;precio;…"
          value={csv}
          onChange={(e) => {
            setFileName(null);
            changeText(e.target.value);
          }}
        />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy === 'preview'}
            disabled={csv.trim() === ''}
            onClick={() =>
              void run('preview', async () => {
                setResult(null);
                setPreview(await api.adminPreviewProductsCsv(csv));
              })
            }
          >
            {t('csv.check')}
          </Button>
        </div>
      </Section>

      {preview && preview.errors.length > 0 && (
        <Section header={t('csv.errorsTitle', { count: preview.errors.length })} footer={t('csv.errorsFooter')}>
          {preview.errors.slice(0, 100).map((issue, i) => (
            <Cell key={`${issue.line}-${issue.code}-${i}`} multiline style={danger}>
              {issueText(issue)}
            </Cell>
          ))}
        </Section>
      )}

      {preview && preview.errors.length === 0 && !result && (
        <Section header={t('csv.previewTitle')} footer={t('csv.previewFooter')}>
          <Cell after={String(creates)}>{t('csv.creates')}</Cell>
          <Cell after={String(updates)}>{t('csv.updates')}</Cell>
          {preview.newCategories.length > 0 && (
            <Cell multiline subtitle={preview.newCategories.join(', ')}>
              {t('csv.newCategories', { count: preview.newCategories.length })}
            </Cell>
          )}
          {preview.products.slice(0, 50).map((p) => (
            <Cell
              key={p.slug}
              subtitle={`/${p.slug}${p.variants > 0 ? ` · ${t('csv.variants', { count: p.variants })}` : ''}`}
              after={p.action === 'create' ? t('csv.new') : t('csv.update')}
            >
              {p.title}
            </Cell>
          ))}
          <div style={{ padding: 16 }}>
            <Button
              stretched
              loading={busy === 'import'}
              disabled={preview.products.length === 0}
              onClick={() =>
                void run('import', async () => {
                  setResult(await api.adminImportProductsCsv(csv));
                  setPreview(null);
                  if (uploadId) void api.deleteUpload(uploadId).catch(() => undefined);
                })
              }
            >
              {t('csv.import', { count: preview.products.length })}
            </Button>
          </div>
        </Section>
      )}

      {result && (
        <Section>
          <Cell multiline>
            {t('csv.done', {
              created: result.created,
              updated: result.updated,
              categories: result.categoriesCreated,
            })}
          </Cell>
        </Section>
      )}
    </List>
  );
}
