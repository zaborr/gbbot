import { describe, expect, it } from 'vitest';
import { langFrom } from '@tma-shop/shared';
import { en } from './en.js';
import { es } from './es.js';
import { it as italian } from './it.js';
import { pt } from './pt.js';

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('translations', () => {
  it('has a Spanish text for every English one, with the same placeholders', () => {
    for (const [key, text] of Object.entries(en)) {
      const spanish = es[key as keyof typeof en];
      expect(spanish, key).toBeTruthy();
      expect(placeholders(spanish), key).toEqual(placeholders(text));
    }
  });

  it('has an Italian and a Portuguese text for every English one, with the same placeholders', () => {
    for (const dictionary of [italian, pt]) {
      for (const [key, text] of Object.entries(en)) {
        const translated = dictionary[key as keyof typeof en];
        expect(translated, key).toBeTruthy();
        expect(placeholders(translated), key).toEqual(placeholders(text));
      }
    }
  });

  it('picks the language from the locale, English otherwise', () => {
    expect(langFrom('es')).toBe('es');
    expect(langFrom('es-AR')).toBe('es');
    expect(langFrom('it')).toBe('it');
    expect(langFrom('it-CH')).toBe('it');
    expect(langFrom('pt-br')).toBe('pt');
    expect(langFrom('pt-PT')).toBe('pt');
    expect(langFrom('en-US')).toBe('en');
    expect(langFrom('ru')).toBe('en');
    expect(langFrom(undefined)).toBe('en');
  });
});
