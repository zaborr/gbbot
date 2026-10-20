import { useEffect, useState } from 'react';
import { ApiClientError } from '../api/client.js';
import { t } from '../i18n/index.js';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /**
   * Goes up each time fresh data arrives. A form that copies `data` into its
   * own state uses it as its `key`, so it starts again from what was saved
   * (keying it on a reload counter instead would rebuild it from the old data
   * while the new one is still on its way).
   */
  version: number;
}

/** Runs an async loader on mount and whenever a dependency in `deps` changes. */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null, version: 0 });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    loader()
      .then((data) => {
        if (!cancelled) setState((prev) => ({ data, loading: false, error: null, version: prev.version + 1 }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiClientError ? err.message : t('error.tryAgain');
        setState((prev) => ({ data: null, loading: false, error: message, version: prev.version }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
