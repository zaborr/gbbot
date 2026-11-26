import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import { api, ApiClientError } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { copyText } from '../lib/clipboard.js';
import { formatDateTime } from '../lib/format.js';
import { Input } from './Field.js';
import { t } from '../i18n/index.js';

const errorText = (err: unknown): string => (err instanceof ApiClientError ? err.message : t('error.title'));

/** A buyer's web access (for when the bot is down): give a key, copy it, take it back. */
export function WebAccessSection({ userId }: { userId: number }): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const current = useAsync(() => api.adminWebKey(userId), [userId, reloadKey]);
  const [given, setGiven] = useState<{ key: string; url: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [vip, setVip] = useState<'none' | 'shop' | 'platform'>('none');
  const key = current.data?.key ?? null;
  const everywhere = current.data?.canVipEverywhere ?? false;

  const run = (what: string, work: () => Promise<void>): void => {
    setBusy(what);
    setNote(null);
    void work()
      .catch((err: unknown) => setNote(errorText(err)))
      .finally(() => setBusy(null));
  };

  return (
    <Section header={t('custKey.title')} footer={note ?? t('custKey.footer')}>
      <Cell multiline>
        {key
          ? t('custKey.active', {
              until: formatDateTime(key.expiresAt),
              used: key.lastUsedAt ? formatDateTime(key.lastUsedAt) : t('custKey.neverUsed'),
            })
          : t('custKey.none')}
      </Cell>
      {given && (
        <Cell
          multiline
          subtitle={given.url}
          after={
            <Button
              size="s"
              mode="bezeled"
              onClick={() =>
                void copyText(t('custKey.message', { url: given.url, key: given.key })).then((ok) =>
                  setNote(ok ? t('sheet.copied') : t('sheet.copyFailed')),
                )
              }
            >
              {t('custKey.copy')}
            </Button>
          }
        >
          <code style={{ fontSize: 16, wordBreak: 'break-all' }}>{given.key}</code>
        </Cell>
      )}
      <div className="gb-tabs" role="radiogroup" style={{ padding: '8px 16px' }}>
        {(['none', 'shop', ...(everywhere ? (['platform'] as const) : [])] as const).map((v) => (
          <Button key={v} size="s" mode={vip === v ? 'filled' : 'bezeled'} onClick={() => setVip(v)}>
            {t(v === 'none' ? 'custKey.vipNone' : v === 'shop' ? 'custKey.vipShop' : 'custKey.vipAll')}
          </Button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 16 }}>
        <Button
          stretched
          mode={key ? 'bezeled' : 'filled'}
          loading={busy === 'give'}
          onClick={() =>
            run('give', async () => {
              const r = await api.adminGiveWebKey(userId, vip);
              setGiven({ key: r.key, url: r.url });
              setReloadKey((k) => k + 1);
            })
          }
        >
          {key ? t('custKey.newKey') : t('custKey.give')}
        </Button>
        {key && (
          <Button
            stretched
            mode="bezeled"
            loading={busy === 'revoke'}
            onClick={() => {
              if (!sure) {
                setSure(true);
                return;
              }
              setSure(false);
              run('revoke', async () => {
                await api.adminRevokeWebKey(userId);
                setGiven(null);
                setReloadKey((k) => k + 1);
              });
            }}
          >
            {sure ? t('custKey.revokeSure') : t('custKey.revoke')}
          </Button>
        )}
      </div>
    </Section>
  );
}

/** Someone new, by their Telegram ID (from @userinfobot), so they can be given a key. */
export function NewCustomerSection(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<number | null>(null);
  const [id, setId] = useState('');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (added !== null) {
    // Added: their key right here (they have no orders yet to find them by).
    return (
      <>
        <Section>
          <Cell multiline>{t('custKey.addedWho', { name, id: added })}</Cell>
        </Section>
        <WebAccessSection userId={added} />
      </>
    );
  }
  if (!open) {
    return (
      <Section>
        <Cell onClick={() => setOpen(true)}>{t('custKey.newCustomer')}</Cell>
      </Section>
    );
  }
  const valid = /^\d{3,15}$/.test(id.trim()) && name.trim() !== '';
  return (
    <Section header={t('custKey.newCustomer')} footer={note ?? t('custKey.newCustomerFooter')}>
      <Input header={t('custKey.telegramId')} inputMode="numeric" value={id} onChange={(e) => setId(e.target.value)} />
      <Input
        header={t('custKey.username')}
        placeholder="@usuario"
        autoCapitalize="none"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <Input header={t('custKey.name')} value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ display: 'flex', gap: 8, padding: 16 }}>
        <Button stretched mode="bezeled" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
        <Button
          stretched
          disabled={!valid}
          loading={busy}
          onClick={() => {
            setBusy(true);
            setNote(null);
            const telegramId = Number(id.trim());
            void api
              .adminAddCustomer({ telegramId, username: username.trim() || null, firstName: name.trim() })
              .then(() => setAdded(telegramId))
              .catch((err: unknown) => setNote(errorText(err)))
              .finally(() => setBusy(false));
          }}
        >
          {t('custKey.add')}
        </Button>
      </div>
    </Section>
  );
}

/** The platform's message on the web's entrance (the bot is down…). */
export function WebBannerEditor(): React.JSX.Element {
  const current = useAsync(() => api.platformWebBanner(), []);
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const value = text ?? current.data?.text ?? '';
  const save = (next: string | null): void => {
    setNote(null);
    void api
      .platformSetWebBanner(next)
      .then(() => {
        setText(next ?? '');
        setNote(next ? t('webBanner.saved') : t('webBanner.removed'));
      })
      .catch((err: unknown) => setNote(errorText(err)));
  };
  return (
    <Section header={t('webBanner.title')} footer={note ?? t('webBanner.footer')}>
      <Input
        header={t('webBanner.field')}
        placeholder={t('webBanner.placeholder')}
        value={value}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, padding: 16 }}>
        <Button stretched mode="bezeled" onClick={() => save(null)}>
          {t('webBanner.remove')}
        </Button>
        <Button stretched disabled={value.trim() === ''} onClick={() => save(value.trim())}>
          {t('common.save')}
        </Button>
      </div>
    </Section>
  );
}
