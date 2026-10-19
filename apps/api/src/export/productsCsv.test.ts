import { describe, expect, it } from 'vitest';
import type { Product } from '@tma-shop/shared';
import { parseCsv, parseMoney, parseTiers, readProductsCsv, writeProductsCsv } from './productsCsv.js';

const HEADER =
  'producto;titulo;descripcion;categoria;moneda;precio;precio_vip;stock;activo;imagen;escalones;opcion1;valor1;opcion2;valor2;precio_variante;stock_variante';

function product(partial: Partial<Product>): Product {
  return {
    id: 'p1',
    shopId: 's',
    categoryId: null,
    slug: 'tea',
    title: 'Tea',
    description: '',
    titleEn: null,
    descriptionEn: null,
    price: 1000,
    vipPrice: null,
    currency: 'USDC',
    imageUrl: null,
    stock: null,
    isActive: true,
    vipOnly: false,
    options: [],
    variants: [],
    priceTiers: [],
    createdAt: '2026-10-18T10:00:00.000Z',
    ...partial,
  };
}

describe('parseCsv', () => {
  it('detects ; and reads quoted cells', () => {
    const { rows, delimiter } = parseCsv('\uFEFFa;b\r\n"x; ""y""";2\n');
    expect(delimiter).toBe(';');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x; "y"', '2'],
    ]);
  });
});

describe('parseMoney / parseTiers', () => {
  it('accepts decimal points and commas', () => {
    expect(parseMoney('12,90')).toBe(1290);
    expect(parseMoney('12.9')).toBe(1290);
    expect(parseMoney('12')).toBe(1200);
    expect(parseMoney('abc')).toBeNull();
    expect(parseTiers('5:9,00|10:8.50')).toEqual([
      { minQty: 5, price: 900 },
      { minQty: 10, price: 850 },
    ]);
    expect(parseTiers('5-9')).toBeNull();
  });
});

describe('readProductsCsv', () => {
  it('groups rows of the same product into variants', () => {
    const csv = [
      HEADER,
      'shirt;T-shirt;Cotton;Clothes;EURC;20,00;15,00;;si;;5:18,00;Size;M;Color;Red;;3',
      'shirt;;;;;;;;si;;;;L;;Red;22,00;',
      'mug;Mug;;;;8;;10;no;;;;;;;;',
    ].join('\n');
    const { products, errors } = readProductsCsv(csv, [], 'USDC');
    expect(errors).toEqual([]);
    expect(products).toHaveLength(2);
    const shirt = products[0]!;
    expect(shirt.input).toMatchObject({
      title: 'T-shirt',
      currency: 'EURC',
      price: 2000,
      vipPrice: 1500,
      priceTiers: [{ minQty: 5, price: 1800 }],
      options: [
        { name: 'Size', values: ['M', 'L'] },
        { name: 'Color', values: ['Red'] },
      ],
    });
    expect(shirt.input.variants).toEqual([
      { values: ['M', 'Red'], price: null, vipPrice: null, stock: 3, isActive: true },
      { values: ['L', 'Red'], price: 2200, vipPrice: null, stock: null, isActive: true },
    ]);
    expect(shirt.category).toBe('Clothes');
    expect(products[1]?.input).toMatchObject({ slug: 'mug', price: 800, stock: 10, isActive: false });
  });

  it('reports problems with their line', () => {
    const csv = [HEADER, 'Bad Slug;X;;;;1;;;;;;;;;;;', 'ok;;;;;abc;;;;;;;;;;;'].join('\n');
    const { products, errors } = readProductsCsv(csv, [], 'USDC');
    expect(products).toEqual([]);
    expect(errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'bad_slug'],
      [3, 'no_title'],
      [3, 'bad_price'],
    ]);
  });

  it('needs the main columns', () => {
    expect(readProductsCsv('titulo,precio\nx,1', [], 'USDC').errors[0]).toMatchObject({
      line: 1,
      code: 'missing_column',
      vars: { column: 'producto' },
    });
  });

  it('keeps what the file does not mention', () => {
    const current = product({ slug: 'tea', imageUrl: 'https://x/t.png', vipPrice: 700 });
    const { products } = readProductsCsv('producto,titulo,precio\ntea,Green tea,11.50', [current], 'USDC');
    expect(products[0]?.existing).toBe(current);
    expect(products[0]?.input).toMatchObject({
      title: 'Green tea',
      price: 1150,
      imageUrl: 'https://x/t.png',
      vipPrice: 700,
    });
    expect(products[0]?.category).toBeUndefined();
  });
});

describe('writeProductsCsv', () => {
  it('reads back what it writes', () => {
    const shirt = product({
      slug: 'shirt',
      title: 'T-shirt; "basic"',
      price: 2000,
      vipPrice: 1500,
      currency: 'EURC',
      categoryId: 'c1',
      priceTiers: [{ minQty: 5, price: 1800 }],
      options: [{ name: 'Size', values: ['M', 'L'] }],
      variants: [
        { id: 'v1', values: ['M'], label: 'M', priceOverride: null, price: 2000, vipPriceOverride: null, vipPrice: 1500, stock: 3, isActive: true },
        { id: 'v2', values: ['L'], label: 'L', priceOverride: 2200, price: 2200, vipPriceOverride: 1700, vipPrice: 1700, stock: null, isActive: false },
      ],
    });
    for (const lang of ['es', 'en'] as const) {
      const csv = writeProductsCsv([shirt], [{ id: 'c1', shopId: 's', slug: 'clothes', title: 'Clothes', sortOrder: 0 }], lang);
      const { products, errors } = readProductsCsv(csv, [], 'USDC');
      expect(errors).toEqual([]);
      expect(products[0]?.input).toMatchObject({
        title: 'T-shirt; "basic"',
        price: 2000,
        vipPrice: 1500,
        currency: 'EURC',
        isActive: true,
        priceTiers: [{ minQty: 5, price: 1800 }],
        options: [{ name: 'Size', values: ['M', 'L'] }],
        variants: [
          { values: ['M'], price: null, vipPrice: null, stock: 3, isActive: true },
          { values: ['L'], price: 2200, vipPrice: 1700, stock: null, isActive: false },
        ],
      });
      expect(products[0]?.category).toBe('Clothes');
    }
  });
});

describe('English versions in the CSV', () => {
  it('reads, clears and writes them back', () => {
    const current = product({ slug: 'tea', titleEn: 'Green tea' });
    const cleared = readProductsCsv('producto,titulo,precio,titulo_en\ntea,Té,11,', [current], 'USDC');
    expect(cleared.products[0]?.input.titleEn).toBeNull();

    const both = product({ slug: 'mug', title: 'Taza', titleEn: 'Mug', descriptionEn: 'Big, "white"' });
    for (const lang of ['es', 'en'] as const) {
      const csv = writeProductsCsv([both], [], lang);
      const { products, errors } = readProductsCsv(csv, [], 'USDC');
      expect(errors).toEqual([]);
      expect(products[0]?.input).toMatchObject({ title: 'Taza', titleEn: 'Mug', descriptionEn: 'Big, "white"' });
    }
  });
});

describe('VIP-only products in the CSV', () => {
  it('reads and writes solo_vip', () => {
    const csv = writeProductsCsv([product({ slug: 'gold', vipOnly: true })], [], 'es');
    expect(csv).toContain(';si;si;');
    const { products, errors } = readProductsCsv(csv, [], 'USDC');
    expect(errors).toEqual([]);
    expect(products[0]?.input.vipOnly).toBe(true);
    const kept = readProductsCsv('producto,titulo,precio\ngold,Gold,1', [product({ slug: 'gold', vipOnly: true })], 'USDC');
    expect(kept.products[0]?.input.vipOnly).toBe(true);
  });
});
