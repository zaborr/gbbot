import { useEffect, useRef } from 'react';

/**
 * Keeps a screen up to date without leaving it:
 * - while `polling` is true, calls `refresh` every `everyMs`;
 * - whenever the app comes back to the front (after reading the bot's
 *   message, switching apps…), calls `refresh` once.
 */
export function useLiveRefresh(refresh: () => void, polling = false, everyMs = 5000): void {
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => latest.current(), everyMs);
    return () => clearInterval(timer);
  }, [polling, everyMs]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') latest.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);
}
