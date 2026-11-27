import { useEffect, useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { api, ApiClientError, type TelegramAuth } from '../api/client.js';
import { useSession } from '../providers/SessionProvider.js';
import { useAsync } from '../hooks/useAsync.js';
import { Input } from './Field.js';
import { PageTitle } from './PageTitle.js';
import { TelegramLoginButton } from './TelegramLogin.js';
import { WebBanner, WebKeySignIn } from './WebChrome.js';
import { SnakeGame } from './SnakeGame.js';
import { QrCode } from './QrCode.js';
import { t } from '../i18n/index.js';

const errorText = (err: unknown): string => (err instanceof ApiClientError ? err.message : t('error.title'));

/** The invitation in the address (`#/alta?c=…`), read once and then taken out of it. */
function codeFromAddress(): string | null {
  const [path, query] = window.location.hash.replace(/^#/, '').split('?');
  if (path !== '/alta') return null;
  const code = new URLSearchParams(query ?? '').get('c');
  // Out of the address bar and the history: it must not stay where others see it.
  window.history.replaceState(null, '', `${window.location.pathname}#/alta`);
  return code;
}

/** Whether "Log in with Telegram" (the login bot) is set up. */
function useLoginBot(): boolean {
  return useAsync(() => api.webConfig(), []).data?.telegramLogin ?? false;
}

/**
 * The customers' web entrance: their account (username and password, or
 * Telegram) or an invitation to open one. A web key only from its own link
 * (/s/<slug>); the staff go to /admin themselves.
 */
export function WebCustomerSignIn(): React.JSX.Element {
  const [code] = useState(codeFromAddress);
  const [signup, setSignup] = useState<string | null>(code);
  const [withKey, setWithKey] = useState(() => /^#\/s\//.test(window.location.hash));
  if (signup !== null) return <WebSignUp initialCode={signup} onBack={() => setSignup(null)} />;
  if (withKey) return <WebKeySignIn onBack={() => setWithKey(false)} />;
  return <WebAccountSignIn onInvite={(c) => setSignup(c)} />;
}

function WebAccountSignIn({ onInvite }: { onInvite: (code: string) => void }): React.JSX.Element {
  const { signInWithSession } = useSession();
  const config = useAsync(() => api.webConfig(), []).data;
  const [claimProof, setClaimProof] = useState<string | null>(null);
  const bot = config?.telegramLogin ?? false;
  const privateMode = config?.privateMode ?? false;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void work()
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <List style={{ maxWidth: 420, margin: '0 auto' }}>
      <WebBanner />
      <PageTitle title={t('acct.signInTitle')} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => signInWithSession(await api.accountLogin(username.trim(), password)));
        }}
      >
        <Section footer={error ?? undefined}>
          <Input
            header={t('acct.username')}
            autoCapitalize="none"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Input
            header={t('acct.password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div style={{ padding: 16 }}>
            <Button stretched type="submit" loading={busy} disabled={username.trim() === '' || password === ''}>
              {t('acct.signIn')}
            </Button>
          </div>
        </Section>
      </form>
      {bot && (
        <Section header={t('acct.withTelegram')} footer={t('acct.withTelegramFooter')}>
          {claimProof ? (
            <ClaimAccount proof={claimProof} onBack={() => setClaimProof(null)} />
          ) : (
            <TelegramLoginButton
              onAuth={(proof) =>
                run(async () => {
                  try {
                    signInWithSession(await api.telegramLogin(proof));
                  } catch (err) {
                    // Already a customer, with no account yet: choose username and password now.
                    if (err instanceof ApiClientError && err.code === 'make_account') setClaimProof(proof);
                    else throw err;
                  }
                })
              }
            />
          )}
        </Section>
      )}
      <Section header={t('acct.haveInvite')} footer={t('acct.haveInviteFooter')}>
        <Input
          header={t('acct.inviteCode')}
          placeholder="river-XXXXX-XXXXX-XXXXX-sage"
          autoCapitalize="none"
          autoComplete="off"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button stretched mode="bezeled" disabled={invite.trim().length < 8} onClick={() => onInvite(invite.trim())}>
            {t('acct.useInvite')}
          </Button>
        </div>
      </Section>
      {privateMode && (
        <Section header={t('gate.meanwhile')}>
          <SnakeGame />
        </Section>
      )}
    </List>
  );
}

/** Already a customer (Telegram just proved it), no account yet: username and password, and in. */
function ClaimAccount({ proof, onBack }: { proof: string; onBack: () => void }): React.JSX.Element {
  const { signInWithSession } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = password !== '' && again !== '' && password !== again;
  return (
    <>
      <Cell multiline>{t('acct.claimIntro')}</Cell>
      <Input header={t('acct.username')} autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <Input header={t('acct.password')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Input header={t('acct.passwordAgain')} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      <div className="gb-hint" style={{ padding: '0 16px' }}>
        {error ?? (mismatch ? t('acct.passwordsDiffer') : t('acct.passwordRule'))}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 16 }}>
        <Button stretched mode="bezeled" onClick={onBack}>
          {t('web.back')}
        </Button>
        <Button
          stretched
          loading={busy}
          disabled={username.trim().length < 3 || password.length < 10 || password !== again}
          onClick={() => {
            setBusy(true);
            setError(null);
            void api
              .telegramClaim({ telegram: proof, username: username.trim(), password })
              .then(signInWithSession)
              .catch((err: unknown) => setError(errorText(err)))
              .finally(() => setBusy(false));
          }}
        >
          {t('acct.createAccount')}
        </Button>
      </div>
    </>
  );
}

/** Opening a web account with an invitation; a group's needs their Telegram (the login bot). */
function WebSignUp({ initialCode, onBack }: { initialCode: string; onBack: () => void }): React.JSX.Element {
  const { signInWithSession } = useSession();
  const bot = useLoginBot();
  const [code] = useState(initialCode);
  const info = useAsync(() => api.inviteInfo(code), [code]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [telegram, setTelegram] = useState<TelegramAuth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (info.error) {
    return (
      <List style={{ maxWidth: 420, margin: '0 auto' }}>
        <PageTitle title={t('acct.signUpTitle')} />
        <Section footer={info.error}>
          <div style={{ padding: 16 }}>
            <Button stretched mode="bezeled" onClick={onBack}>
              {t('web.back')}
            </Button>
          </div>
        </Section>
      </List>
    );
  }
  const group = info.data?.kind === 'group';
  const mismatch = password !== '' && again !== '' && password !== again;
  const ready =
    info.data !== null &&
    username.trim().length >= 3 &&
    password.length >= 10 &&
    password === again &&
    (!group || telegram !== null);

  return (
    <List style={{ maxWidth: 420, margin: '0 auto' }}>
      <WebBanner />
      <PageTitle title={t('acct.signUpTitle')} />
      {info.data?.kind === 'personal' && (
        <Section>
          <Cell multiline>{t('acct.personalFor', { name: info.data.name ?? '' })}</Cell>
        </Section>
      )}
      <Section header={t('acct.chooseLogin')} footer={mismatch ? t('acct.passwordsDiffer') : t('acct.passwordRule')}>
        <Input
          header={t('acct.username')}
          autoCapitalize="none"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Input
          header={t('acct.password')}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Input
          header={t('acct.passwordAgain')}
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </Section>
      <Section
        header={group ? t('acct.linkTelegram') : t('acct.confirmTelegram')}
        footer={group ? t('acct.linkTelegramFooter') : t('acct.confirmTelegramFooter')}
      >
        {telegram ? (
          <Cell multiline after={<Button size="s" mode="plain" onClick={() => setTelegram(null)}>{t('acct.change')}</Button>}>
            {t('acct.telegramReady')}
          </Cell>
        ) : bot ? (
          <TelegramLoginButton onAuth={setTelegram} label={t('acct.linkButton')} />
        ) : (
          <Cell multiline>{t('acct.noLoginBot')}</Cell>
        )}
      </Section>
      <Section footer={error ?? undefined}>
        <div style={{ display: 'flex', gap: 8, padding: 16 }}>
          <Button stretched mode="bezeled" onClick={onBack}>
            {t('web.back')}
          </Button>
          <Button
            stretched
            loading={busy}
            disabled={!ready}
            onClick={() => {
              setBusy(true);
              setError(null);
              void api
                .signUp({ code, username: username.trim(), password, ...(telegram ? { telegram } : {}) })
                .then((session) => {
                  window.location.hash = '#/';
                  signInWithSession(session);
                })
                .catch((err: unknown) => setError(errorText(err)))
                .finally(() => setBusy(false));
            }}
          >
            {t('acct.createAccount')}
          </Button>
        </div>
      </Section>
    </List>
  );
}

/**
 * Their web account, from inside: make one (Mini App, or a web key), confirm
 * the Telegram the staff tied it to, change the password.
 */
export function AccountSections({
  inTelegram,
  onCreated,
}: {
  inTelegram: boolean;
  onCreated?: () => void;
}): React.JSX.Element {
  const { replaceWebToken } = useSession();
  const bot = useLoginBot();
  const [reload, setReload] = useState(0);
  const current = useAsync(() => api.myAccount(), [reload]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setNote(null), [reload]);

  const run = (work: () => Promise<string | null>): void => {
    setBusy(true);
    setNote(null);
    void work()
      .then((done) => {
        setPassword('');
        setAgain('');
        setCurrentPassword('');
        setReload((n) => n + 1);
        if (done) window.setTimeout(() => setNote(done), 0);
      })
      .catch((err: unknown) => setNote(errorText(err)))
      .finally(() => setBusy(false));
  };
  if (current.loading && !current.data) return <Section>{null}</Section>;
  const account = current.data?.account ?? null;
  const mismatch = password !== '' && again !== '' && password !== again;
  const passwordsOk = password.length >= 10 && password === again;

  if (!account) {
    return (
      <Section
        header={t('acct.createTitle')}
        footer={note ?? (mismatch ? t('acct.passwordsDiffer') : inTelegram ? t('acct.createFooterTelegram') : t('acct.createFooterWeb'))}
      >
        <Input
          header={t('acct.username')}
          autoCapitalize="none"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Input header={t('acct.password')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Input header={t('acct.passwordAgain')} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={username.trim().length < 3 || !passwordsOk}
            onClick={() =>
              run(async () => {
                const made = await api.createMyAccount({ username: username.trim(), password });
                // On the web: from now on, this session is the account's (every GB).
                if (!inTelegram) replaceWebToken(made.token, made.expiresAt);
                onCreated?.();
                return inTelegram ? t('acct.createdTelegram') : t('acct.created');
              })
            }
          >
            {t('acct.createAccount')}
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <>
      {!inTelegram && !account.manages && current.data?.managesSomething && <ManageOnWeb />}
      <Section header={t('acct.yourAccount')} footer={note ?? undefined}>
        <Cell subtitle={account.linkState === 'confirmed' ? t('acct.linkConfirmed') : t('acct.linkByStaff')}>{account.username}</Cell>
        {account.linkState === 'staff' && bot && (
          <TelegramLoginButton
            label={t('acct.confirmButton')}
            onAuth={(proof) =>
              run(async () => {
                await api.confirmMyAccount(proof);
                return t('acct.confirmed');
              })
            }
          />
        )}
      </Section>
      <Section header={t('acct.changePassword')} footer={mismatch ? t('acct.passwordsDiffer') : t('acct.changeFooter')}>
        {!inTelegram && (
          <Input
            header={t('acct.currentPassword')}
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        )}
        <Input header={t('acct.newPassword')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Input header={t('acct.passwordAgain')} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        <div style={{ padding: 16 }}>
          <Button
            stretched
            loading={busy}
            disabled={!passwordsOk || (!inTelegram && currentPassword === '')}
            onClick={() =>
              run(async () => {
                const fresh = await api.changeMyPassword({ password, ...(inTelegram ? {} : { current: currentPassword }) });
                if (!inTelegram) replaceWebToken(fresh.token, fresh.expiresAt);
                return t('acct.passwordChanged');
              })
            }
          >
            {t('acct.changePassword')}
          </Button>
        </div>
        {!inTelegram && bot && (
          <>
            <Cell multiline>{t('acct.forgotWithTelegram')}</Cell>
            <TelegramLoginButton
              label={t('acct.resetButton')}
              onAuth={(proof) => {
                if (!passwordsOk) {
                  setNote(t('acct.typeNewFirst'));
                  return;
                }
                run(async () => {
                  const fresh = await api.changeMyPassword({ password, telegram: proof });
                  replaceWebToken(fresh.token, fresh.expiresAt);
                  return t('acct.passwordChanged');
                });
              }}
            />
          </>
        )}
      </Section>
    </>
  );
}

/**
 * Someone who manages GBs, signed in with their account: add the authenticator
 * to manage on the web too (Telegram proves it is them first).
 */
function ManageOnWeb(): React.JSX.Element {
  const [enrol, setEnrol] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <Section header={t('acct.manageTitle')}>
        <Cell multiline>{t('acct.manageDone')}</Cell>
        <div style={{ padding: 16 }}>
          <Button stretched onClick={() => (window.location.href = '/admin')}>
            {t('acct.toStaff')}
          </Button>
        </div>
      </Section>
    );
  }
  if (!enrol) {
    return (
      <Section header={t('acct.manageTitle')} footer={note ?? t('acct.manageFooter')}>
        <TelegramLoginButton
          label={t('acct.manageButton')}
          onAuth={(proof) => {
            setNote(null);
            void api
              .startManaging(proof)
              .then(setEnrol)
              .catch((err: unknown) => setNote(errorText(err)));
          }}
        />
      </Section>
    );
  }
  return (
    <Section header={t('acct.manageTitle')} footer={note ?? t('acct.manageScan')}>
      <div style={{ padding: 16 }}>
        <QrCode text={enrol.otpauth} />
      </div>
      <Cell multiline subtitle={t('webAccess.secret')}>
        <code style={{ wordBreak: 'break-all' }}>{enrol.secret}</code>
      </Cell>
      <Input
        header={t('acct.manageCode')}
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
      <div style={{ padding: 16 }}>
        <Button
          stretched
          loading={busy}
          disabled={code.length < 6}
          onClick={() => {
            setBusy(true);
            setNote(null);
            void api
              .confirmManaging(code)
              .then(() => setDone(true))
              .catch((err: unknown) => setNote(errorText(err)))
              .finally(() => setBusy(false));
          }}
        >
          {t('acct.manageConfirm')}
        </Button>
      </div>
    </Section>
  );
}
