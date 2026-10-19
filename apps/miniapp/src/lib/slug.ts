/**
 * Kebab-case slug from a human title: "Té Verde Sencha" → "te-verde-sencha".
 * Accents are stripped; falls back to a random id for titles with no latin
 * letters or digits (e.g. only emoji), since the API requires a non-empty slug.
 */
export function toSlug(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || `item-${Date.now().toString(36)}`;
}
