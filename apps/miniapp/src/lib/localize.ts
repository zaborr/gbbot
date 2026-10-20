import { localized } from '@tma-shop/shared';
import { lang } from '../i18n/index.js';

/**
 * Texts the organisers write in Spanish and, optionally, English: Spanish for
 * apps in Spanish, English for every other language (Spanish when there is no
 * English version). Admin screens keep showing the Spanish text.
 */
export function local(es: string, en: string | null | undefined): string {
  return localized(lang(), es, en);
}

export function productTitle(p: { title: string; titleEn?: string | null | undefined }): string {
  return local(p.title, p.titleEn);
}

export function productDescription(p: { description: string; descriptionEn?: string | null | undefined }): string {
  return local(p.description, p.descriptionEn);
}

export function shopName(s: { name: string; nameEn?: string | null | undefined }): string {
  return local(s.name, s.nameEn);
}

export function shopDescription(s: { description: string; descriptionEn?: string | null | undefined }): string {
  return local(s.description, s.descriptionEn);
}
