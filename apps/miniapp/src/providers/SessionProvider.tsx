import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { retrieveRawInitData } from '@telegram-apps/sdk-react';
import type { AuthResponse, SessionUser, WebRole } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { setLang, t } from '../i18n/index.js';
import { isWebMode, setWebSession, webSession } from '../lib/web.js';

/** `signin`: web mode without a session (the sign-in form is shown). */
type Status = 'loading' | 'ready' | 'error' | 'signin';

interface SessionValue {
  status: Status;
  user: SessionUser | null;
  error: string | null;
  /** Platform super-admin: creates shops, hides them and assigns their admins. */
  isSuperAdmin: boolean;
  /** Web mode: signs in with username, password and authenticator code. */
  signIn: (username: string, password: string, code: string) => Promise<void>;
  /** Web mode: forgets the session in this tab. */
  signOut: () => void;
  /** Web mode: the account's role (null in Telegram). */
  webRole: WebRole | null;
  /** Web mode: keeps working with a new token (after changing the password). */
  replaceWebToken: (token: string, expiresAt: string) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webRole, setWebRole] = useState<WebRole | null>(null);

  // Web mode: the session of this tab; when it expires, back to the form.
  const startWeb = useCallback((session: AuthResponse | null): void => {
    setWebSession(session);
    api.setToken(session?.token ?? null);
    api.setReauth(
      session
        ? async () => {
            setWebSession(null);
            setUser(null);
            setStatus('signin');
            throw new Error(t('web.expired'));
          }
        : null,
    );
    // A linked account (a Telegram user) uses that user's language.
    if (session && session.user.telegramId > 0) {
      setLang(session.user.language, session.user.preferredLanguage);
    }
    setUser(session?.user ?? null);
    setWebRole(session?.webRole ?? null);
    setStatus(session ? 'ready' : 'signin');
  }, []);

  const signIn = useCallback(
    async (username: string, password: string, code: string): Promise<void> => {
      startWeb(await api.webAuth({ username, password, code }));
    },
    [startWeb],
  );
  const signOut = useCallback(() => startWeb(null), [startWeb]);
  const replaceWebToken = useCallback((token: string, expiresAt: string) => {
    const session = webSession();
    if (session) setWebSession({ ...session, token, expiresAt });
    api.setToken(token);
  }, []);

  useEffect(() => {
    if (isWebMode()) {
      startWeb(webSession());
      return undefined;
    }
    let cancelled = false;
    async function authenticate(): Promise<void> {
      try {
        const initDataRaw = retrieveRawInitData();
        if (!initDataRaw) throw new Error(t('env.description'));
        const session = await api.auth(initDataRaw);
        if (cancelled) return;
        api.setToken(session.token);
        // The language saved for this user (chosen in the app, else Telegram's).
        setLang(session.user.language, session.user.preferredLanguage);
        // Sessions last an hour; renew silently with the same launch data.
        api.setReauth(async () => (await api.auth(initDataRaw)).token);
        setUser(session.user);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('app.signInFailed'));
        setStatus('error');
      }
    }
    void authenticate();
    return () => {
      cancelled = true;
    };
  }, [startWeb]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      error,
      isSuperAdmin: user?.role === 'admin',
      signIn,
      signOut,
      webRole,
      replaceWebToken,
    }),
    [status, user, error, signIn, signOut, webRole, replaceWebToken],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
