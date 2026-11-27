import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import { api, ApiClientError } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { copyText } from '../lib/clipboard.js';
import { formatDateTime } from '../lib/format.js';
import { Input } from './Field.js';
import { t } from '../i18n/index.js';

const errorText = (err: unknown): string => (err instanceof ApiClientError ? err.message : t('error.title'));

/** The message to send with an invitation: the link (with the code in it), and the others in case. */
function inviteMessage(given: { url: string; more: string[] }, personal: boolean): string {
  return (
    t(personal ? 'invite.personalMessage' : 'invite.groupMessage', { url: given.url }) +
    (given.more.length ? `\n${t('custKey.more', { urls: given.more.join('\n') })}` : '')
  );
}

/**
 * A buyer's web access: their account (or an invitation to open one), a new
 * password when Telegram cannot prove who they are, and an old web key.
 */
export function WebAccessSection({ userId }: { userId: number }): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const status = useAsync(() => api.adminAccount(userId), [userId, reloadKey]);
  const legacy = useAsync(() => api.adminWebKey(userId), [userId, reloadKey]);
  const [given, setGiven] = useState<{ url: string; more: string[] } | null>(null);
  const [fresh, setFresh] = useState<{ username: string; password: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  const [vip, setVip] = useState<'none' | 'shop' | 'platform'>('none');
  const account = status.data?.account ?? null;
  const key = legacy.data?.key ?? null;
  const everywhere = legacy.data?.canVipEverywhere ?? false;

  const run = (what: string, work: () => Promise<void>): void => {
    setBusy(what);
    setNote(null);
    void work()
      .catch((err: unknown) => setNote(errorText(err)))
      .finally(() => setBusy(null));
  };
  const copy = (text: string): void =>
    void copyText(text).then((ok) => setNote(ok ? t('sheet.copied') : t('sheet.copyFailed')));
  const confirmFirst = (what: string, work: () => void): void => {
    if (sure !== what) {
      setSure(what);
      return;
    }
    setSure(null);
    work();
  };

  return (
    <Section header={t('custKey.title')} footer={note ?? t('invite.accessFooter')}>
      <Cell
        multiline
        subtitle={
          account
            ? account.linkState === 'confirmed'
              ? t('invite.linkConfirmed')
              : t('invite.linkByStaff', { who: account.linkedBy ?? '—' })
            : undefined
        }
      >
        {account ? t('invite.hasAccount', { username: account.username }) : t('invite.noAccount')}
      </Cell>
      {account && (
        <Cell multiline subtitle={formatDateTime(account.createdAt)}>
          {account.invitedBy
            ? t(account.invitedBy.kind === 'group' ? 'invite.cameGroup' : 'invite.camePersonal', { who: account.invitedBy.who })
            : t('invite.cameOwn')}
        </Cell>
      )}

      {!account && (
        <>
          {given && (
            <Cell
              multiline
              subtitle={[given.url, ...given.more].join('\n')}
              after={
                <Button size="s" mode="bezeled" onClick={() => copy(inviteMessage(given, true))}>
                  {t('custKey.copy')}
                </Button>
              }
            >
              {t('invite.made')}
            </Cell>
          )}
          <div className="gb-tabs" role="radiogroup" style={{ padding: '8px 16px' }}>
            {(['none', 'shop', ...(everywhere ? (['platform'] as const) : [])] as const).map((v) => (
              <Button key={v} size="s" mode={vip === v ? 'filled' : 'bezeled'} onClick={() => setVip(v)}>
                {t(v === 'none' ? 'custKey.vipNone' : v === 'shop' ? 'custKey.vipShop' : 'custKey.vipAll')}
              </Button>
            ))}
          </div>
          <div style={{ padding: 16 }}>
            <Button
              stretched
              loading={busy === 'invite'}
              onClick={() =>
                run('invite', async () => {
                  const r = await api.adminCreateInvite({ kind: 'personal', userId, vip });
                  setGiven({ url: r.url, more: r.more });
                })
              }
            >
              {given ? t('invite.again') : t('invite.personal')}
            </Button>
          </div>
        </>
      )}

      {account && status.data?.canReset && !account.manages && (
        <>
          {fresh && (
            <Cell
              multiline
              after={
                <Button size="s" mode="bezeled" onClick={() => copy(t('invite.resetMessage', fresh))}>
                  {t('custKey.copy')}
                </Button>
              }
            >
              <code style={{ wordBreak: 'break-all' }}>
                {fresh.username} · {fresh.password}
              </code>
            </Cell>
          )}
          <div style={{ padding: 16 }}>
            <Button
              stretched
              mode="bezeled"
              loading={busy === 'reset'}
              onClick={() =>
                confirmFirst('reset', () =>
                  run('reset', async () => {
                    setFresh(await api.adminResetAccount(userId));
                    setReloadKey((k) => k + 1);
                  }),
                )
              }
            >
              {sure === 'reset' ? t('invite.resetSure') : t('invite.reset')}
            </Button>
          </div>
        </>
      )}

      {key && (
        <>
          <Cell multiline>
            {t('custKey.active', {
              until: formatDateTime(key.expiresAt),
              used: key.lastUsedAt ? formatDateTime(key.lastUsedAt) : t('custKey.neverUsed'),
            })}
          </Cell>
          <div style={{ padding: 16 }}>
            <Button
              stretched
              mode="bezeled"
              loading={busy === 'revoke'}
              onClick={() =>
                confirmFirst('revoke', () =>
                  run('revoke', async () => {
                    await api.adminRevokeWebKey(userId);
                    setReloadKey((k) => k + 1);
                  }),
                )
              }
            >
              {sure === 'revoke' ? t('custKey.revokeSure') : t('custKey.revoke')}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

/** Out of the platform (platform admins and supervisors): blacklist, keys, web account, their invitations. */
export function ExpelSection({ userId }: { userId: number }): React.JSX.Element | null {
  const status = useAsync(() => api.adminAccount(userId), [userId]);
  const [reason, setReason] = useState('');
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!status.data?.canExpel) return null;
  return (
    <Section header={t('expel.title')} footer={note ?? t('expel.footer')}>
      {done ? (
        <Cell multiline>{t('expel.done')}</Cell>
      ) : (
        <>
          <Input header={t('expel.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ padding: 16 }}>
            <Button
              stretched
              mode={sure ? 'filled' : 'bezeled'}
              loading={busy}
              disabled={reason.trim() === ''}
              onClick={() => {
                if (!sure) {
                  setSure(true);
                  return;
                }
                setSure(false);
                setBusy(true);
                setNote(null);
                void api
                  .adminExpel(userId, reason.trim())
                  .then(() => setDone(true))
                  .catch((err: unknown) => setNote(errorText(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {sure ? t('expel.sure') : t('expel.button')}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

/** Group invitations of this GB: one link for many people, until it expires. */
export function GroupInviteSection(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.adminInvites(), [reloadKey]);
  const [days, setDays] = useState(3);
  const [given, setGiven] = useState<{ url: string; more: string[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState<string | null>(null);
  const now = Date.now();
  const active = (list.data ?? []).filter((i) => !i.revoked && new Date(i.expiresAt).getTime() > now && (i.kind === 'group' || i.uses === 0));

  return (
    <Section header={t('invite.groupTitle')} footer={note ?? t('invite.groupFooter')}>
      {given && (
        <Cell
          multiline
          subtitle={[given.url, ...given.more].join('\n')}
          after={
            <Button
              size="s"
              mode="bezeled"
              onClick={() =>
                void copyText(inviteMessage(given, false)).then((ok) => setNote(ok ? t('sheet.copied') : t('sheet.copyFailed')))
              }
            >
              {t('custKey.copy')}
            </Button>
          }
        >
          {t('invite.made')}
        </Cell>
      )}
      <div className="gb-tabs" role="radiogroup" style={{ padding: '8px 16px' }}>
        {[1, 3, 7, 14, 30].map((d) => (
          <Button key={d} size="s" mode={days === d ? 'filled' : 'bezeled'} onClick={() => setDays(d)}>
            {t('invite.days', { n: d })}
          </Button>
        ))}
      </div>
      <div style={{ padding: 16 }}>
        <Button
          stretched
          loading={busy}
          onClick={() => {
            setBusy(true);
            setNote(null);
            void api
              .adminCreateInvite({ kind: 'group', days })
              .then((r) => {
                setGiven({ url: r.url, more: r.more });
                setReloadKey((k) => k + 1);
              })
              .catch((err: unknown) => setNote(errorText(err)))
              .finally(() => setBusy(false));
          }}
        >
          {t('invite.group')}
        </Button>
      </div>
      {active.map((i) => (
        <Cell
          key={i.id}
          multiline
          subtitle={t('invite.line', {
            who: i.createdBy,
            until: formatDateTime(i.expiresAt),
            uses: i.uses,
          })}
          after={
            <Button
              size="s"
              mode="bezeled"
              onClick={() => {
                if (sure !== i.id) {
                  setSure(i.id);
                  return;
                }
                setSure(null);
                void api
                  .adminRevokeInvite(i.id)
                  .then(() => setReloadKey((k) => k + 1))
                  .catch((err: unknown) => setNote(errorText(err)));
              }}
            >
              {sure === i.id ? t('invite.revokeSure') : t('invite.revoke')}
            </Button>
          }
        >
          {i.kind === 'group' ? t('invite.groupKind') : t('invite.personalKind', { who: i.forWhom ?? '' })}
        </Cell>
      ))}
    </Section>
  );
}

/** Someone new, by their Telegram ID (from @userinfobot), so they can be given a key. */
export function NewCustomerSection(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<{ id: number; name: string } | null>(null);
  const [username, setUsername] = useState('');
  // null: not searched yet; [] : nobody with that @username (then by ID).
  const [found, setFound] = useState<{ telegramId: number; username: string | null; firstName: string }[] | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (added !== null) {
    // Their key right here (they may have no orders yet to find them by).
    return (
      <>
        <Section>
          <Cell multiline>{t('custKey.addedWho', { name: added.name, id: added.id })}</Cell>
        </Section>
        <WebAccessSection userId={added.id} />
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
  const close = (): void => {
    setOpen(false);
    setFound(null);
    setNote(null);
  };
  const cancel = (
    <Button stretched mode="bezeled" onClick={close}>
      {t('common.cancel')}
    </Button>
  );

  // 1. By @username.
  if (found === null) {
    const handle = username.trim().replace(/^@/, '');
    return (
      <Section header={t('custKey.newCustomer')} footer={note ?? t('custKey.searchFooter')}>
        <Input
          header={t('custKey.usernameSearch')}
          placeholder="@usuario"
          autoCapitalize="none"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, padding: 16 }}>
          {cancel}
          <Button
            stretched
            disabled={handle.length < 2}
            loading={busy}
            onClick={() => {
              setBusy(true);
              setNote(null);
              void api
                .adminFindCustomer(handle)
                .then(setFound)
                .catch((err: unknown) => setNote(errorText(err)))
                .finally(() => setBusy(false));
            }}
          >
            {t('custKey.search')}
          </Button>
        </div>
      </Section>
    );
  }

  // 2a. Found: confirm who it is.
  if (found.length > 0) {
    return (
      <Section header={t('custKey.newCustomer')} footer={t('custKey.foundFooter')}>
        {found.map((u) => (
          <Cell
            key={u.telegramId}
            multiline
            subtitle={`${u.username ? `@${u.username} · ` : ''}${u.telegramId}`}
            after={
              <Button size="s" onClick={() => setAdded({ id: u.telegramId, name: u.firstName })}>
                {t('custKey.thisOne')}
              </Button>
            }
          >
            {u.firstName}
          </Cell>
        ))}
        <div style={{ display: 'flex', gap: 8, padding: 16 }}>
          {cancel}
          <Button stretched mode="bezeled" onClick={() => setFound([])}>
            {t('custKey.notThem')}
          </Button>
        </div>
      </Section>
    );
  }

  // 2b. Not in the bot: by their Telegram ID.
  const valid = /^\d{3,15}$/.test(id.trim());
  return (
    <Section header={t('custKey.newCustomer')} footer={note ?? t('custKey.newCustomerFooter')}>
      <Input
        header={t('custKey.telegramId')}
        inputMode="numeric"
        value={id}
        onChange={(e) => setId(e.target.value.replace(/\D/g, ''))}
      />
      <Input header={t('custKey.name')} value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ display: 'flex', gap: 8, padding: 16 }}>
        {cancel}
        <Button
          stretched
          disabled={!valid}
          loading={busy}
          onClick={() => {
            setBusy(true);
            setNote(null);
            const telegramId = Number(id.trim());
            const handle = username.trim().replace(/^@/, '') || null;
            void api
              .adminAddCustomer({ telegramId, username: handle, firstName: name.trim() })
              .then(() => setAdded({ id: telegramId, name: name.trim() || (handle ? `@${handle}` : '—') }))
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
