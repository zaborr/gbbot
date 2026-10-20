/** Languages the shop speaks. English is the fallback for everyone else. */
export const LANGS = ['en', 'es', 'it', 'pt'] as const;
export type Lang = (typeof LANGS)[number];

/** True if `value` is one of the supported languages. */
export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** Picks the language from a Telegram/BCP-47 code such as `es`, `pt-BR` or `en-US`. */
export function langFrom(code: string | null | undefined): Lang {
  const base = code?.toLowerCase().split(/[-_]/)[0];
  return isLang(base) ? base : 'en';
}

/** A user's language: the one they chose in the app, else their Telegram one. */
export function userLang(
  preferred: string | null | undefined,
  telegramCode: string | null | undefined,
): Lang {
  return isLang(preferred) ? preferred : langFrom(telegramCode);
}

/**
 * Texts written by organisers come in Spanish and, optionally, English: Spanish
 * for apps in Spanish, English for every other language (Spanish again when
 * there is no English version, and English when the Spanish one is empty).
 */
export function localized(lang: string, es: string, en: string | null | undefined): string {
  const english = en?.trim() ? en : null;
  if (lang === 'es') return es.trim() ? es : (english ?? es);
  return english ?? es;
}
