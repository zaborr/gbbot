import { retrieveRawInitData } from '@telegram-apps/sdk-react';
import { isLang, langFrom, type Lang } from '@tma-shop/shared';
import { en, type MessageKey } from './en.js';
import { es } from './es.js';
import { it } from './it.js';
import { pt } from './pt.js';

export type { MessageKey };

const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, es, it, pt };

const STORAGE_KEY = 'tma-shop:lang';

/** Language chosen on this device earlier (kept so the app opens in it straight away). */
function remembered(): Lang | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

/** Language of the user's Telegram, from the launch data (browser language as a fallback). */
export function telegramLang(): Lang {
  try {
    const raw = retrieveRawInitData();
    const user = raw ? new URLSearchParams(raw).get('user') : null;
    const code = user ? (JSON.parse(user) as { language_code?: string }).language_code : undefined;
    if (code) return langFrom(code);
  } catch {
    // Not launched from Telegram (or no user): fall back to the browser.
  }
  return langFrom(typeof navigator === 'undefined' ? undefined : navigator.language);
}

let current: Lang | null = null;
const listeners = new Set<(lang: Lang) => void>();

/** Current language: the one chosen in the app, else Telegram's. */
export function lang(): Lang {
  current ??= remembered() ?? telegramLang();
  return current;
}

/**
 * Switches the app language. `chosen` is what the user picked (null = follow
 * Telegram); it is remembered on this device so the next launch starts in it.
 */
export function setLang(next: Lang, chosen: Lang | null = next): void {
  try {
    if (chosen) window.localStorage.setItem(STORAGE_KEY, chosen);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: the choice still lives on the server.
  }
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener(next);
}

/** Calls `listener` whenever the language changes; returns the unsubscribe. */
export function onLangChange(listener: (lang: Lang) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const LOCALES: Record<Lang, string> = { en: 'en-GB', es: 'es-ES', it: 'it-IT', pt: 'pt-PT' };

/** Locale for dates and numbers in the current language. */
export function locale(): string {
  return LOCALES[lang()];
}

/** Translated text for `key`, with `{name}` placeholders filled from `vars`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let text = dictionaries[lang()][key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** `count` with the singular or plural text: `tn(3, 'units')` → "3 units" / "3 unidades". */
export function tn(
  count: number,
  one: MessageKey,
  other: MessageKey,
  vars?: Record<string, string | number>,
): string {
  return t(count === 1 ? one : other, { count, ...vars });
}
