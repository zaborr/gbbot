import { useEffect, useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { api, ApiClientError } from '../api/client.js';
import { useSession } from '../providers/SessionProvider.js';
import { useAsync } from '../hooks/useAsync.js';
import { Input } from './Field.js';
import { PageTitle } from './PageTitle.js';
import {
  TelegramLoginButton,
  isTelegramReturn,
  parseTelegramContext,
  stashTelegram,
  takeTelegram,
  ticketFromAddress,
} from './TelegramLogin.js';
import { Loader } from './Loader.js';
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
 * The customers' web entrance: "Log in with Telegram" (the first time it also
 * asks for a password), their username and password, or an invitation. A web
 * key only from its own link (/s/<slug>); the staff go to /admin themselves.
 */
export function WebCustomerSignIn(): React.JSX.Element {
  const [code] = useState(codeFromAddress);
  const [signup, setSignup] = useState<string | null>(code);
  const [withKey, setWithKey] = useState(() => /^#\/s\//.test(window.location.hash));
  const [back, setBack] = useState(isTelegramReturn);
  if (back) {
    return (
      <TelegramReturn
        onBack={() => {
          window.history.replaceState(null, '', `${window.location.pathname}#/`);
          setBack(false);
        }}
      />
    );
  }
  if (signup !== null) return <WebSignUp initialCode={signup} onBack={() => setSignup(null)} />;
  if (withKey) return <WebKeySignIn onBack={() => setWithKey(false)} />;
  return <WebAccountSignIn onInvite={(c) => setSignup(c)} />;
}

function WebAccountSignIn({ onInvite }: { onInvite: (code: string) => void }): React.JSX.Element {
  const { signInWithSession } = useSession();
  const config = useAsync(() => api.webConfig(), []).data;
  const bot = config?.telegramLogin ?? false;
  const privateMode = config?.privateMode ?? false;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <List style={{ maxWidth: 420, margin: '0 auto' }}>
      <WebBanner />
      <PageTitle title={t('acct.signInTitle')} />
      {bot && (
        <Section header={t('acct.withTelegram')} footer={t('acct.withTelegramFooter')}>
          <TelegramLoginButton purpose="login" />
        </Section>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          void api
            .accountLogin(username.trim(), password)
            .then(signInWithSession)
            .catch((err: unknown) => setError(errorText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <Section header={bot ? t('acct.withPassword') : undefined} footer={error ?? t('acct.signInHint')}>
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

/**
 * Back from Telegram (`#/tg?t=…`): finishes what the page was doing. Signing
 * in or up: in, or (no account yet) a password first. Confirming, a new
 * password or managing: on to 👤 My account, which picks it up.
 */
export function TelegramReturn({ onBack }: { onBack?: () => void }): React.JSX.Element {
  const { status, signInWithSession } = useSession();
  const signedIn = status === 'ready';
  const [ticket] = useState(ticketFromAddress);
  const [claim, setClaim] = useState<{ code?: string; username: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const back = (): void => {
    if (onBack) onBack();
    else window.location.hash = '#/';
  };
  useEffect(() => {
    if (!ticket) {
      setError(t('acct.telegramFailed'));
      return;
    }
    let live = true;
    void (async () => {
      const result = await api.telegramLoginResult(ticket);
      const context = parseTelegramContext(result.context);
      if (result.status !== 'ready') throw new Error(t('acct.telegramFailed'));
      if (signedIn) {
        if (context.p === 'confirm' || context.p === 'reset' || context.p === 'manage') stashTelegram(context.p, ticket);
        window.location.hash = context.p === 'login' || context.p === 'signup' ? '#/' : '#/cuenta';
        return;
      }
      try {
        const session = await api.telegramLogin(ticket, context.c);
        window.location.hash = '#/';
        signInWithSession(session);
      } catch (err) {
        // No account yet (an invitation, or already a customer): a password first.
        if (err instanceof ApiClientError && err.code === 'make_account') {
          if (live) setClaim({ ...(context.c ? { code: context.c } : {}), username: result.username });
          return;
        }
        throw err;
      }
    })().catch((err: unknown) => {
      if (live) setError(err instanceof Error && !(err instanceof ApiClientError) ? err.message : errorText(err));
    });
    return () => {
      live = false;
    };
    // Once, with the ticket it came back with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (claim && ticket) return <ClaimAccount proof={ticket} code={claim.code} suggested={claim.username} onBack={back} />;
  if (!error) return <Loader />;
  return (
    <List style={{ maxWidth: 420, margin: '0 auto' }}>
      <PageTitle title={t('acct.signInTitle')} />
      <Section footer={error}>
        <div style={{ padding: 16 }}>
          <Button stretched mode="bezeled" onClick={back}>
            {t('web.back')}
          </Button>
        </div>
      </Section>
    </List>
  );
}

/**
 * The first time with Telegram, no account yet: a username (their Telegram
 * one to start with) and a password, for when Telegram or the bot fail.
 */
function ClaimAccount({
  proof,
  code,
  suggested,
  onBack,
}: {
  proof: string;
  code?: string | undefined;
  suggested: string | null;
  onBack: () => void;
}): React.JSX.Element {
  const { signInWithSession } = useSession();
  const [username, setUsername] = useState((suggested ?? '').toLowerCase());
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = password !== '' && again !== '' && password !== again;
  return (
    <List style={{ maxWidth: 420, margin: '0 auto' }}>
      <WebBanner />
      <PageTitle title={t('acct.claimTitle')} />
      <Section footer={error ?? (mismatch ? t('acct.passwordsDiffer') : t('acct.passwordRule'))}>
        <Cell multiline>{t('acct.claimIntro')}</Cell>
        <Input header={t('acct.username')} autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <Input header={t('acct.password')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Input header={t('acct.passwordAgain')} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
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
                .telegramClaim({ telegram: proof, username: username.trim(), password, ...(code ? { code } : {}) })
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
 * Opening a web account with an invitation. A personal one: username and
 * password straight away (its Telegram is the one the staff gave), or Telegram.
 * A group's: Telegram first, then a password.
 */
function WebSignUp({ initialCode, onBack }: { initialCode: string; onBack: () => void }): React.JSX.Element {
  const { signInWithSession } = useSession();
  const bot = useLoginBot();
  const [code] = useState(initialCode);
  const info = useAsync(() => api.inviteInfo(code), [code]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const backButton = (
    <div style={{ padding: 16 }}>
      <Button stretched mode="bezeled" onClick={onBack}>
        {t('web.back')}
      </Button>
    </div>
  );
  if (info.error) {
    return (
      <List style={{ maxWidth: 420, margin: '0 auto' }}>
        <PageTitle title={t('acct.signUpTitle')} />
        <Section footer={info.error}>{backButton}</Section>
      </List>
    );
  }
  const personal = info.data?.kind === 'personal';
  const mismatch = password !== '' && again !== '' && password !== again;
  const ready = info.data !== null && username.trim().length >= 3 && password.length >= 10 && password === again;

  return (
    <List style={{ maxWidth: 420, margin: '0 auto' }}>
      <WebBanner />
      <PageTitle title={t('acct.signUpTitle')} />
      {personal && (
        <Section>
          <Cell multiline>{t('acct.personalFor', { name: info.data?.name ?? '' })}</Cell>
        </Section>
      )}
      {personal && (
        <Section header={t('acct.chooseLogin')} footer={error ?? (mismatch ? t('acct.passwordsDiffer') : t('acct.passwordRule'))}>
          <Input header={t('acct.username')} autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input header={t('acct.password')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Input header={t('acct.passwordAgain')} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          <div style={{ padding: 16 }}>
            <Button
              stretched
              loading={busy}
              disabled={!ready}
              onClick={() => {
                setBusy(true);
                setError(null);
                void api
                  .signUp({ code, username: username.trim(), password })
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
      )}
      {(!personal || bot) && (
        <Section
          header={t(personal ? 'acct.signUpOrTelegram' : 'acct.signUpTelegram')}
          footer={bot ? t('acct.signUpTelegramFooter') : undefined}
        >
          {bot ? <TelegramLoginButton purpose="signup" code={code} /> : <Cell multiline>{t('acct.noLoginBot')}</Cell>}
        </Section>
      )}
      <Section>{backButton}</Section>
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
  // Back from Telegram for a new password: it is them, no current one needed.
  const [resetProof, setResetProof] = useState(() => takeTelegram('reset'));
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
  // Back from Telegram to confirm the account's Telegram: done now.
  useEffect(() => {
    const proof = takeTelegram('confirm');
    if (proof) {
      run(async () => {
        await api.confirmMyAccount(proof);
        return t('acct.confirmed');
      });
    }
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (resetProof) setNote(t('acct.resetReady'));
  }, [resetProof]);
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
        {account.linkState === 'staff' && bot && !inTelegram && (
          <TelegramLoginButton purpose="confirm" label={t('acct.confirmButton')} />
        )}
      </Section>
      <Section header={t('acct.changePassword')} footer={mismatch ? t('acct.passwordsDiffer') : t('acct.changeFooter')}>
        {!inTelegram && !resetProof && (
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
            disabled={!passwordsOk || (!inTelegram && !resetProof && currentPassword === '')}
            onClick={() =>
              run(async () => {
                const fresh = await api.changeMyPassword({
                  password,
                  ...(inTelegram ? {} : resetProof ? { telegram: resetProof } : { current: currentPassword }),
                });
                setResetProof(null);
                if (!inTelegram) replaceWebToken(fresh.token, fresh.expiresAt);
                return t('acct.passwordChanged');
              })
            }
          >
            {t('acct.changePassword')}
          </Button>
        </div>
        {!inTelegram && bot && !resetProof && (
          <>
            <Cell multiline>{t('acct.forgotWithTelegram')}</Cell>
            <TelegramLoginButton purpose="reset" label={t('acct.resetButton')} />
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
  // Back from Telegram: it is them, show the authenticator's code to scan.
  useEffect(() => {
    const proof = takeTelegram('manage');
    if (proof) {
      void api
        .startManaging(proof)
        .then(setEnrol)
        .catch((err: unknown) => setNote(errorText(err)));
    }
  }, []);
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
        <TelegramLoginButton purpose="manage" label={t('acct.manageButton')} />
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
