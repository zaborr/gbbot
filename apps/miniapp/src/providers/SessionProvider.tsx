import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { retrieveRawInitData } from '@telegram-apps/sdk-react';
import type { SessionUser } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { setLang, t } from '../i18n/index.js';

type Status = 'loading' | 'ready' | 'error';

interface SessionValue {
  status: Status;
  user: SessionUser | null;
  error: string | null;
  /** Platform super-admin: creates shops, hides them and assigns their admins. */
  isSuperAdmin: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ status, user, error, isSuperAdmin: user?.role === 'admin' }),
    [status, user, error],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
