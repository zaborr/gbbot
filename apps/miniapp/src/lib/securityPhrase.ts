import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

/**
 * The customer's security phrase, loaded once and shared by every screen
 * (undefined while loading, null when not chosen yet).
 */
let current: string | null | undefined;
let loading: Promise<void> | null = null;
const listeners = new Set<(phrase: string | null | undefined) => void>();

function publish(phrase: string | null): void {
  current = phrase;
  for (const listener of listeners) listener(phrase);
}

function load(): void {
  loading ??= api
    .getSecurityPhrase()
    .then(({ phrase }) => publish(phrase))
    .catch(() => {
      loading = null;
    });
}

export function useSecurityPhrase(): {
  phrase: string | null | undefined;
  save: (phrase: string) => Promise<void>;
} {
  const [phrase, setPhrase] = useState(current);
  useEffect(() => {
    listeners.add(setPhrase);
    if (current === undefined) load();
    else setPhrase(current);
    return () => {
      listeners.delete(setPhrase);
    };
  }, []);
  const save = async (value: string): Promise<void> => {
    const saved = await api.setSecurityPhrase(value.trim());
    publish(saved.phrase);
  };
  return { phrase, save };
}
