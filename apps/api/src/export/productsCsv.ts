import {
  PRODUCT_CSV_COLUMNS,
  priceTiers as priceTiersSchema,
  productInput,
  slug as slugSchema,
  type Category,
  type CsvIssue,
  type Lang,
  type PriceTier,
  type Product,
  type ProductCsvColumn,
  type ProductInput,
  type VariantInput,
} from '@tma-shop/shared';
import { ApiError } from '../lib/errors.js';
import { validateVariants } from '../services/variants.js';

/**
 * Products as CSV, one row per variant. Export uses `;` and decimal commas
 * for Spanish, Italian and Portuguese (what Excel expects there) and `,` with
 * decimal points in English; import accepts either.
 */

const MAX_ROWS = 5000;

// --- Reading -------------------------------------------------------------------

/** Splits CSV text into rows of cells (quotes, "" escapes, CRLF). */
export function parseCsv(text: string): { rows: string[][]; delimiter: ',' | ';' } {
  const body = text.replace(/^\uFEFF/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, delimiter };
}

/** "12,90" or "12.90" → 1290 cents; null when it is not a price. */
export function parseMoney(text: string): number | null {
  const value = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

/** "5:9.00|10:8,50" → tiers; null when malformed. */
export function parseTiers(text: string): PriceTier[] | null {
  const value = text.trim();
  if (value === '') return [];
  const tiers: PriceTier[] = [];
  for (const part of value.split('|')) {
    const [qty, price] = part.split(':');
    const minQty = Number(qty?.trim());
    const cents = price === undefined ? null : parseMoney(price);
    if (!Number.isInteger(minQty) || cents === null) return null;
    tiers.push({ minQty, price: cents });
  }
  const parsed = priceTiersSchema.safeParse(tiers);
  return parsed.success ? parsed.data : null;
}

function parseActive(text: string): boolean | null {
  const value = text.trim().toLowerCase();
  if (['si', 'sí', 'yes', 'y', 's', '1', 'true', 'x', 'sim'].includes(value)) return true;
  if (['no', 'n', '0', 'false', 'nao', 'não'].includes(value)) return false;
  return null;
}

/** "Té Verde" → "te-verde" (like the app). */
export function toSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export interface ParsedProduct {
  /** Line of its first row. */
  line: number;
  slug: string;
  input: ProductInput;
  /** Category title as written, null for none, undefined to keep the current one. */
  category: string | null | undefined;
  existing: Product | null;
}

interface Row {
  line: number;
  get: (column: ProductCsvColumn) => string;
  has: (column: ProductCsvColumn) => boolean;
}

/**
 * Reads the file into products ready to save. Columns that are missing keep
 * the product's current value (or the default for a new one); nothing is
 * ever deleted. Every problem is reported with its line.
 */
export function readProductsCsv(
  text: string,
  existing: readonly Product[],
  defaultCurrency: string,
): { products: ParsedProduct[]; errors: CsvIssue[] } {
  const errors: CsvIssue[] = [];
  const issue = (line: number, code: string, vars: Record<string, string | number> = {}): void => {
    errors.push({ line, code, vars });
  };
  const { rows } = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const index = new Map<string, number>();
  header.forEach((name, i) => index.set(name, i));
  for (const required of ['producto', 'titulo', 'precio'] as const) {
    if (!index.has(required)) issue(1, 'missing_column', { column: required });
  }
  if (errors.length > 0) return { products: [], errors };
  const unknown = header.filter((h) => h !== '' && !(PRODUCT_CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0) issue(1, 'unknown_columns', { columns: unknown.join(', ') });

  const body = rows
    .slice(1)
    .map((cells, i): Row => ({
      line: i + 2,
      get: (column) => (cells[index.get(column) ?? -1] ?? '').trim(),
      has: (column) => index.has(column),
    }))
    .filter((row) => PRODUCT_CSV_COLUMNS.some((c) => row.get(c) !== ''));
  if (body.length === 0) issue(1, 'empty');
  if (body.length > MAX_ROWS) issue(1, 'too_many_rows', { max: MAX_ROWS });
  if (errors.length > 0) return { products: [], errors };

  // Rows with the same `producto` are one product, in the order they appear.
  const groups = new Map<string, Row[]>();
  for (const row of body) {
    const slug = row.get('producto');
    if (!slugSchema.safeParse(slug).success) {
      issue(row.line, slug === '' ? 'no_slug' : 'bad_slug', { value: slug });
      continue;
    }
    groups.set(slug, [...(groups.get(slug) ?? []), row]);
  }

  const bySlug = new Map(existing.map((p) => [p.slug, p]));
  const products: ParsedProduct[] = [];
  for (const [slug, group] of groups) {
    const before = errors.length;
    const first = group[0] as Row;
    const current = bySlug.get(slug) ?? null;
    // Product fields: the first row that fills them in.
    const field = (column: ProductCsvColumn): { row: Row; value: string } | null => {
      const row = group.find((r) => r.get(column) !== '');
      return row ? { row, value: row.get(column) } : null;
    };

    const title = field('titulo')?.value ?? '';
    if (!title) issue(first.line, 'no_title', { slug });

    const priceCell = field('precio');
    const price = priceCell ? parseMoney(priceCell.value) : null;
    if (priceCell && price === null) issue(priceCell.row.line, 'bad_price', { value: priceCell.value });
    if (!priceCell) issue(first.line, 'no_price', { slug });

    let vipPrice = current?.vipPrice ?? null;
    if (first.has('precio_vip')) {
      const cell = field('precio_vip');
      vipPrice = cell ? parseMoney(cell.value) : null;
      if (cell && vipPrice === null) issue(cell.row.line, 'bad_price', { value: cell.value });
    }

    let currency = current?.currency ?? defaultCurrency;
    if (first.has('moneda') && field('moneda')) {
      const cell = field('moneda') as { row: Row; value: string };
      currency = cell.value.toUpperCase();
      if (currency !== 'USDC' && currency !== 'EURC') {
        issue(cell.row.line, 'bad_currency', { value: cell.value });
      }
    }

    // `activo`: without options, the product; with options, each row's variant
    // (all of them "no" = the product is hidden).
    let isActive = current?.isActive ?? true;
    for (const row of group) {
      const text = row.get('activo');
      if (text !== '' && parseActive(text) === null) issue(row.line, 'bad_active', { value: text });
    }
    const activeOf = (row: Row): boolean | null =>
      row.get('activo') === '' ? null : parseActive(row.get('activo'));

    // `minimo`: minimum units per order, all variants together; empty = none.
    let minQuantity = current?.minQuantity ?? 1;
    if (first.has('minimo')) {
      const cell = field('minimo');
      const value = cell ? Number(cell.value) : 1;
      if (cell && (!/^\d+$/.test(cell.value) || value < 1 || value > 999)) {
        issue(cell.row.line, 'bad_minimum', { value: cell.value });
      }
      minQuantity = Number.isInteger(value) && value >= 1 && value <= 999 ? value : 1;
    }

    // `solo_vip`: the whole product (si/no); empty = no.
    let vipOnly = current?.vipOnly ?? false;
    if (first.has('solo_vip')) {
      const cell = field('solo_vip');
      const value = cell ? parseActive(cell.value) : false;
      if (cell && value === null) issue(cell.row.line, 'bad_active', { value: cell.value });
      vipOnly = value ?? false;
    }

    let imageUrl = current?.imageUrl ?? null;
    if (first.has('imagen')) {
      const cell = field('imagen');
      imageUrl = cell?.value ?? null;
      if (cell && !/^https:\/\/\S+$/i.test(cell.value)) {
        issue(cell.row.line, 'bad_url', { value: cell.value });
      }
    }

    let priceTiers = current?.priceTiers ?? [];
    if (first.has('escalones')) {
      const cell = field('escalones');
      const parsed = cell ? parseTiers(cell.value) : [];
      if (parsed === null) issue(cell?.row.line ?? first.line, 'bad_tiers', { value: cell?.value ?? '' });
      else priceTiers = parsed;
    }

    const description = first.has('descripcion')
      ? (field('descripcion')?.value ?? '')
      : (current?.description ?? '');
    const category = first.has('categoria') ? (field('categoria')?.value ?? null) : undefined;
    // English versions: an empty cell means "none" (the Spanish text is shown).
    const titleEn = first.has('titulo_en') ? (field('titulo_en')?.value ?? null) : (current?.titleEn ?? null);
    const descriptionEn = first.has('descripcion_en')
      ? (field('descripcion_en')?.value ?? null)
      : (current?.descriptionEn ?? null);

    // Options: names from the first row that has them; values from every row.
    const optionColumns = [1, 2, 3] as const;
    const hasOptionColumns = optionColumns.some((n) => first.has(`opcion${n}`));
    let options = current?.options ?? [];
    let variants: VariantInput[] =
      current?.variants.map((v) => ({
        values: v.values,
        price: v.priceOverride,
        vipPrice: v.vipPriceOverride,
        stock: v.stock,
        isActive: v.isActive,
      })) ?? [];
    let stock = current?.stock ?? null;

    if (hasOptionColumns) {
      const names = optionColumns
        .map((n) => field(`opcion${n}`)?.value ?? '')
        .filter((name) => name !== '');
      const usesOptions = names.length > 0;
      if (!usesOptions) {
        options = [];
        variants = [];
        if (group.length > 1) issue(group[1]?.line ?? first.line, 'repeated_product', { slug });
      } else {
        const values: string[][] = names.map(() => []);
        variants = [];
        for (const row of group) {
          const combo = names.map((_, i) => row.get(`valor${i + 1}` as ProductCsvColumn));
          if (combo.some((v) => v === '')) {
            issue(row.line, 'missing_value', { slug });
            continue;
          }
          combo.forEach((v, i) => {
            const list = values[i] as string[];
            if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
          });
          const priceText = row.get('precio_variante');
          const vipText = row.get('precio_vip_variante');
          const stockText = row.get('stock_variante');
          const variantPrice = priceText === '' ? null : parseMoney(priceText);
          const variantVip = vipText === '' ? null : parseMoney(vipText);
          if (priceText !== '' && variantPrice === null) issue(row.line, 'bad_price', { value: priceText });
          if (vipText !== '' && variantVip === null) issue(row.line, 'bad_price', { value: vipText });
          if (stockText !== '' && !/^\d+$/.test(stockText)) issue(row.line, 'bad_stock', { value: stockText });
          const rowActive = activeOf(row) ?? true;
          variants.push({
            values: combo,
            price: variantPrice,
            vipPrice: variantVip,
            stock: stockText === '' ? null : Number(stockText),
            isActive: rowActive,
          });
        }
        options = names.map((name, i) => ({ name, values: values[i] as string[] }));
        if (variants.length > 0 && variants.every((v) => !v.isActive)) {
          isActive = false;
          for (const v of variants) v.isActive = true;
        } else if (group.some((r) => r.get('activo') !== '')) {
          isActive = true;
        }
      }
    } else if (group.length > 1) {
      issue(group[1]?.line ?? first.line, 'repeated_product', { slug });
    }

    if (options.length === 0) {
      const value = activeOf(first);
      if (value !== null) isActive = value;
      const cell = field('stock');
      if (first.has('stock')) {
        stock = cell ? (/^\d+$/.test(cell.value) ? Number(cell.value) : null) : null;
        if (cell && !/^\d+$/.test(cell.value)) issue(cell.row.line, 'bad_stock', { value: cell.value });
      }
    } else {
      stock = null;
    }

    if (errors.length > before) continue;

    const input = {
      categoryId: current?.categoryId ?? null,
      slug,
      title,
      description,
      titleEn,
      descriptionEn,
      price: price ?? 0,
      vipPrice,
      currency,
      imageUrl,
      stock,
      isActive,
      vipOnly,
      minQuantity,
      options,
      priceTiers,
      variants,
    };
    const checked = productInput.safeParse(input);
    if (!checked.success) {
      issue(first.line, 'invalid', { message: checked.error.issues[0]?.message ?? 'invalid' });
      continue;
    }
    try {
      validateVariants(checked.data.options, checked.data.variants);
    } catch (error) {
      issue(first.line, 'invalid', { message: error instanceof ApiError ? error.message : 'invalid' });
      continue;
    }
    products.push({
      line: first.line,
      slug,
      input: checked.data,
      category,
      existing: current,
    });
  }
  return { products, errors };
}

// --- Writing -------------------------------------------------------------------

/** The catalog as CSV text, one row per variant. */
export function writeProductsCsv(
  products: readonly Product[],
  categories: readonly Category[],
  lang: Lang,
): string {
  const delimiter = lang === 'en' ? ',' : ';';
  const decimal = lang === 'en' ? '.' : ',';
  const money = (cents: number | null): string =>
    cents === null ? '' : (cents / 100).toFixed(2).replace('.', decimal);
  const yesNo = (value: boolean): string =>
    value ? (lang === 'en' ? 'yes' : lang === 'pt' ? 'sim' : 'si') : 'no';
  const categoryTitle = new Map(categories.map((c) => [c.id, c.title]));
  const quote = (text: string): string =>
    text.includes(delimiter) || /["\r\n]/.test(text) || /^\s|\s$/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text;

  const lines: string[] = [PRODUCT_CSV_COLUMNS.join(delimiter)];
  for (const product of products) {
    const base: Partial<Record<ProductCsvColumn, string>> = {
      producto: product.slug,
      titulo: product.title,
      descripcion: product.description,
      titulo_en: product.titleEn ?? '',
      descripcion_en: product.descriptionEn ?? '',
      categoria: product.categoryId ? (categoryTitle.get(product.categoryId) ?? '') : '',
      moneda: product.currency,
      precio: money(product.price),
      precio_vip: money(product.vipPrice),
      stock: product.options.length === 0 && product.stock !== null ? String(product.stock) : '',
      activo: yesNo(product.isActive),
      solo_vip: yesNo(product.vipOnly),
      minimo: product.minQuantity > 1 ? String(product.minQuantity) : '',
      imagen: product.imageUrl ?? '',
      escalones: product.priceTiers.map((t) => `${t.minQty}:${money(t.price)}`).join('|'),
    };
    const rows: Array<Partial<Record<ProductCsvColumn, string>>> =
      product.options.length === 0
        ? [base]
        : product.variants.map((v, i) => {
            const row: Partial<Record<ProductCsvColumn, string>> = {
              // Product fields on its first row only, to keep the file readable.
              ...(i === 0 ? base : { producto: product.slug }),
              precio_variante: money(v.priceOverride),
              precio_vip_variante: money(v.vipPriceOverride),
              stock_variante: v.stock === null ? '' : String(v.stock),
            };
            // A hidden product: every row "no".
            row.activo = yesNo(product.isActive && v.isActive);
            product.options.forEach((option, n) => {
              row[`opcion${n + 1}` as ProductCsvColumn] = option.name;
              row[`valor${n + 1}` as ProductCsvColumn] = v.values[n] ?? '';
            });
            return row;
          });
    for (const row of rows) {
      lines.push(PRODUCT_CSV_COLUMNS.map((c) => quote(row[c] ?? '')).join(delimiter));
    }
  }
  return `\uFEFF${lines.join('\n')}\n`;
}
