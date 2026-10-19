import { useEffect, useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { Textarea } from '../../components/Field.js';
import { api } from '../../api/client.js';
import { copyText } from '../../lib/clipboard.js';
import {
  cryptoAvailable,
  generateAddressKeys,
  loadPrivateKey,
  privateKeyMatches,
  savePrivateKey,
} from '../../lib/addressCrypto.js';
import { useShop } from '../../providers/ShopProvider.js';
import { AdminOnly, ErrorBanner, useAdminActions } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t } from '../../i18n/index.js';

/**
 * The shop's address key pair. The public key is stored on the server; the
 * private key stays on the admin's device (and wherever they back it up).
 */
export function AdminAddressKeyPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <AdminAddressKey />
    </AdminOnly>
  );
}

type DeviceKey = 'none' | 'matches' | 'other' | 'checking';

function AdminAddressKey(): React.JSX.Element {
  const { shop, reload } = useShop();
  const actions = useAdminActions(reload);
  const [deviceKey, setDeviceKey] = useState<DeviceKey>('checking');
  const [newPrivateKey, setNewPrivateKey] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [allowMismatch, setAllowMismatch] = useState(false);
  const [pastedPublic, setPastedPublic] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const stored = loadPrivateKey(shop.id);
    if (!stored) {
      setDeviceKey('none');
      return;
    }
    if (!shop.addressPublicKey) {
      setDeviceKey('other');
      return;
    }
    setDeviceKey('checking');
    void privateKeyMatches(stored, shop.addressPublicKey).then((ok) => {
      if (!cancelled) setDeviceKey(ok ? 'matches' : 'other');
    });
    return () => {
      cancelled = true;
    };
  }, [shop.id, shop.addressPublicKey, refresh]);

  if (!cryptoAvailable()) {
    return (
      <List>
      <PageTitle title={t('adminHome.addressKey')} />
        <Section>
          <Cell multiline>This device can’t run the encryption needed for address keys.</Cell>
        </Section>
      </List>
    );
  }

  const generate = async (): Promise<void> => {
    setBusy(true);
    await actions.run(async () => {
      const keys = await generateAddressKeys();
      await api.adminUpdateAddressKey(keys.publicKey);
      savePrivateKey(shop.id, keys.privateKeyPem);
      setNewPrivateKey(keys.privateKeyPem);
      setCopied(false);
      setRefresh((n) => n + 1);
    });
    setBusy(false);
  };

  const savePasted = async (): Promise<void> => {
    setPasteError(null);
    const pem = pasted.trim();
    if (!pem.includes('PRIVATE KEY')) {
      setPasteError(t('key.pasteWhole'));
      return;
    }
    const matches = shop.addressPublicKey ? await privateKeyMatches(pem, shop.addressPublicKey) : false;
    if (!matches && !allowMismatch) {
      setPasteError(t('key.mismatch'));
      setAllowMismatch(true);
      return;
    }
    if (!savePrivateKey(shop.id, pem)) {
      setPasteError(t('key.cannotSave'));
      return;
    }
    setPasted('');
    setAllowMismatch(false);
    setRefresh((n) => n + 1);
  };

  const uploadPublic = async (): Promise<void> => {
    setBusy(true);
    await actions.run(async () => {
      await api.adminUpdateAddressKey(pastedPublic.trim());
      setPastedPublic('');
      setRefresh((n) => n + 1);
    });
    setBusy(false);
  };

  const hasKey = shop.addressPublicKey !== null;
  // Changing the key is for the GB's administrators; anyone in the team can
  // keep the private key on their device to read addresses.
  const canChange = shop.canOwn;

  return (
    <List>
      <PageTitle title={t('adminHome.addressKey')} />
      <ErrorBanner message={actions.error} />

      <Section
        header={t('key.title')}
        footer={t('key.footer')}
      >
        <Cell after={hasKey ? (shop.addressKeyFingerprint ?? '✓') : t('common.notSet')}>
          {t('key.public')}
        </Cell>
        <Cell
          after={
            deviceKey === 'checking'
              ? '…'
              : deviceKey === 'matches'
                ? t('key.matches')
                : deviceKey === 'other'
                  ? t('key.other')
                  : t('productForm.none')
          }
        >
          {t('key.onDevice')}
        </Cell>
      </Section>

      {newPrivateKey && (
        <Section
          header={t('key.saveNow')}
          footer={t('key.saveNowFooter')}
        >
          <Textarea value={newPrivateKey} readOnly />
          <div style={{ padding: 16 }}>
            <Button
              stretched
              onClick={() => void copyText(newPrivateKey).then(setCopied)}
            >
              {copied ? t('key.copied') : t('key.copy')}
            </Button>
          </div>
        </Section>
      )}

      {!canChange && (
        <Section>
          <Cell multiline>{t('owner.readOnly')}</Cell>
        </Section>
      )}

      {canChange && (
      <Section
        header={hasKey ? t('key.replace') : t('key.create')}
        footer={hasKey ? t('key.replaceFooter') : t('key.createFooter')}
      >
        <div style={{ padding: 16 }}>
          <Button
            stretched
            mode={hasKey ? 'bezeled' : 'filled'}
            loading={busy}
            onClick={() =>
              hasKey ? void actions.twoTap('generate', generate) : void generate()
            }
          >
            {hasKey
              ? actions.tapLabel('generate', t('key.generateNew'), t('key.generateNewConfirm'))
              : t('key.generate')}
          </Button>
        </div>
      </Section>
      )}

      <Section
        header={t('key.useHere')}
        footer={t('key.useHereFooter')}
      >
        <Textarea
          header={t('key.private')}
          placeholder="-----BEGIN PRIVATE KEY----- …"
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value);
            setAllowMismatch(false);
          }}
        />
        {pasteError && (
          <Cell multiline style={{ color: 'var(--tgui--destructive_text_color)' }}>
            {pasteError}
          </Cell>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Button stretched disabled={!pasted.trim()} onClick={() => void savePasted()}>
            {allowMismatch ? t('key.saveAnyway') : t('key.saveHere')}
          </Button>
          {deviceKey !== 'none' && (
            <Button
              stretched
              mode="plain"
              onClick={() =>
                void actions.twoTap('forget', async () => {
                  savePrivateKey(shop.id, null);
                  setRefresh((n) => n + 1);
                })
              }
            >
              {actions.tapLabel('forget', t('key.forget'))}
            </Button>
          )}
        </div>
      </Section>

      {canChange && (
      <Section
        header={t('key.advanced')}
        footer={t('key.advancedFooter')}
      >
        <Textarea
          header={t('key.publicField')}
          placeholder="-----BEGIN PUBLIC KEY----- …"
          value={pastedPublic}
          onChange={(e) => setPastedPublic(e.target.value)}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Button
            stretched
            mode="bezeled"
            disabled={pastedPublic.trim().length < 100}
            onClick={() => void uploadPublic()}
          >
            {t('key.setPublic')}
          </Button>
          {hasKey && (
            <Button
              stretched
              mode="plain"
              onClick={() =>
                void actions.twoTap('remove', () => api.adminUpdateAddressKey(null))
              }
            >
              {actions.tapLabel('remove', t('key.remove'))}
            </Button>
          )}
        </div>
      </Section>
      )}
    </List>
  );
}
