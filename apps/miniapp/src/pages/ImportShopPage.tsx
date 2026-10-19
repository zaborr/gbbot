import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { GbBackupPreview } from '@tma-shop/shared';
import { Input } from '../components/Field.js';
import { api } from '../api/client.js';
import { shopPath } from '../providers/ShopProvider.js';
import { ErrorBanner, useAdminActions } from './admin/common.js';
import { t } from '../i18n/index.js';

const breakAll: React.CSSProperties = { wordBreak: 'break-all', whiteSpace: 'normal' };

/**
 * Organisers and super-admins: a GB from a backup file. The receiving
 * addresses are shown and must be confirmed before anything is saved.
 */
export function ImportShopPage(): React.JSX.Element {
  const navigate = useNavigate();
  const actions = useAdminActions(() => undefined);
  const [backup, setBackup] = useState<unknown>(null);
  const [preview, setPreview] = useState<GbBackupPreview | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (text: string): Promise<void> => {
    setPreview(null);
    setConfirmed(false);
    setFileError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setFileError(t('importGb.notJson'));
      return;
    }
    await actions.run(async () => {
      const result = await api.organizerPreviewBackup(parsed);
      setBackup(parsed);
      setPreview(result);
      setName(result.name);
      setSlug(result.slugTaken ? `${result.slug}-2`.slice(0, 64) : result.slug);
    });
  };

  const pick = async (file: File | undefined): Promise<void> => {
    if (file) await load(await file.text());
  };

  // Opened from the bot ("Open to import"): the backup sent to it.
  const [params] = useSearchParams();
  const uploadId = params.get('upload');
  useEffect(() => {
    if (!uploadId) return;
    void actions.run(async () => {
      await load((await api.getUpload(uploadId)).content);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId]);

  const hasWallets =
    preview !== null &&
    (preview.evmAddress !== null || preview.solanaAddress !== null || preview.manualMethods.length > 0);

  const importIt = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    await actions.run(async () => {
      const shop = await api.organizerImportBackup({
        backup,
        name: name.trim(),
        slug: slug.trim(),
        confirmedEvmAddress: preview.evmAddress,
        confirmedSolanaAddress: preview.solanaAddress,
      });
      if (uploadId) void api.deleteUpload(uploadId).catch(() => undefined);
      navigate(shopPath(shop.slug, '/admin'), { replace: true });
    });
    setBusy(false);
  };

  return (
    <List>
      <ErrorBanner message={actions.error ?? fileError} />
      <Section header={t('importGb.title')} footer={t('importGb.footer')}>
        <div style={{ padding: '12px 16px' }}>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => void pick(e.target.files?.[0])}
            style={{ maxWidth: '100%' }}
          />
        </div>
      </Section>

      {preview && (
        <>
          <Section header={t('importGb.contents')}>
            <Cell after={String(preview.products)}>{t('deleteShop.products')}</Cell>
            <Cell after={String(preview.variants)}>{t('importGb.variants')}</Cell>
            <Cell after={String(preview.categories)}>{t('categories.title')}</Cell>
            <Cell after={String(preview.shippingZones)}>{t('importGb.zones')}</Cell>
            <Cell after={preview.hasAddressKey ? '✓' : '—'}>{t('adminHome.addressKey')}</Cell>
            <Cell multiline>{t('importGb.exportedAt', { date: new Date(preview.exportedAt).toLocaleString() })}</Cell>
          </Section>

          <Section header={t('importGb.walletsTitle')} footer={t('importGb.walletsFooter')}>
            {!hasWallets && <Cell multiline>{t('importGb.noWallets')}</Cell>}
            {preview.evmAddress && (
              <Cell subtitle="Base / Ethereum" multiline>
                <span style={breakAll}>{preview.evmAddress}</span>
              </Cell>
            )}
            {preview.solanaAddress && (
              <Cell subtitle="Solana" multiline>
                <span style={breakAll}>{preview.solanaAddress}</span>
              </Cell>
            )}
            {preview.manualMethods.map((m) => (
              <Cell key={m.name} subtitle={m.name} multiline>
                <span style={{ whiteSpace: 'pre-wrap' }}>{m.instructions}</span>
              </Cell>
            ))}
            {hasWallets && (
              <Cell
                multiline
                onClick={() => setConfirmed((v) => !v)}
                after={
                  <Button size="s" mode={confirmed ? 'filled' : 'bezeled'}>
                    {confirmed ? '✓' : t('importGb.confirm')}
                  </Button>
                }
              >
                {t('importGb.confirmText')}
              </Cell>
            )}
          </Section>

          <Section header={t('importGb.newGb')} footer={t('importGb.newGbFooter')}>
            <Input header={t('settings.name')} value={name} onChange={(e) => setName(e.target.value)} />
            <Input
              header={t('platformShop.slug')}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <div style={{ padding: 16 }}>
              <Button
                stretched
                loading={busy}
                disabled={!name.trim() || !slug.trim() || (hasWallets && !confirmed)}
                onClick={() => void importIt()}
              >
                {t('importGb.import')}
              </Button>
            </div>
          </Section>
        </>
      )}
    </List>
  );
}
