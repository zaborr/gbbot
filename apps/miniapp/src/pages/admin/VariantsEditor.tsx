import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../../components/Field.js';
import type { Product, ProductOption, VariantInput } from '@tma-shop/shared';
import { toMajor } from './common.js';
import { t } from '../../i18n/index.js';

/** An option as typed in the form: values are comma-separated text. */
export interface OptionDraft {
  name: string;
  values: string;
}

/** Per-combination fields as typed: empty price = product price, empty stock = unlimited. */
export interface VariantDraft {
  price: string;
  /** Empty = the product's VIP price. */
  vipPrice: string;
  stock: string;
  active: boolean;
}

export const MAX_OPTIONS = 3;
export const MAX_VARIANTS = 200;

const PRICE_RE = /^\d+([.,]\d{1,2})?$/;
const STOCK_RE = /^\d+$/;

export function parseValues(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((v) => v.trim())
    .filter((v) => {
      const key = v.toLowerCase();
      if (!v || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function comboKey(values: readonly string[]): string {
  return values.map((v) => v.toLowerCase()).join('\u0000');
}

/** Every combination of the options' values, in option order. */
export function combinations(options: readonly ProductOption[]): string[][] {
  return options.reduce<string[][]>(
    (acc, option) => acc.flatMap((combo) => option.values.map((value) => [...combo, value])),
    [[]],
  );
}

export function initialOptions(product: Product | null): OptionDraft[] {
  return (product?.options ?? []).map((o) => ({ name: o.name, values: o.values.join(', ') }));
}

export function initialDrafts(product: Product | null): Record<string, VariantDraft> {
  const drafts: Record<string, VariantDraft> = {};
  for (const v of product?.variants ?? []) {
    drafts[comboKey(v.values)] = {
      price: v.priceOverride === null ? '' : toMajor(v.priceOverride),
      vipPrice: v.vipPriceOverride === null ? '' : toMajor(v.vipPriceOverride),
      stock: v.stock === null ? '' : String(v.stock),
      active: v.isActive,
    };
  }
  return drafts;
}

/** Options and variants ready to save, or the first problem found. */
export function buildVariants(
  optionDrafts: readonly OptionDraft[],
  drafts: Readonly<Record<string, VariantDraft>>,
): { options: ProductOption[]; variants: VariantInput[] } | { error: string } {
  const options = optionDrafts
    .map((o) => ({ name: o.name.trim(), values: parseValues(o.values) }))
    .filter((o) => o.name !== '' || o.values.length > 0);
  if (options.some((o) => o.name === '')) return { error: t('variants.needName') };
  if (options.some((o) => o.values.length === 0)) return { error: t('variants.needValues') };
  const names = new Set(options.map((o) => o.name.toLowerCase()));
  if (names.size !== options.length) return { error: t('variants.uniqueNames') };
  if (options.length === 0) return { options: [], variants: [] };

  const combos = combinations(options);
  if (combos.length > MAX_VARIANTS) {
    return { error: t('variants.tooMany', { count: combos.length, max: MAX_VARIANTS }) };
  }
  const variants: VariantInput[] = [];
  for (const values of combos) {
    const draft = drafts[comboKey(values)] ?? { price: '', vipPrice: '', stock: '', active: true };
    const price = draft.price.trim();
    const vipPrice = (draft.vipPrice ?? '').trim();
    const stock = draft.stock.trim();
    if ((price !== '' && !PRICE_RE.test(price)) || (vipPrice !== '' && !PRICE_RE.test(vipPrice))) {
      return { error: t('variants.badPrice', { name: values.join(' / ') }) };
    }
    if (stock !== '' && !STOCK_RE.test(stock)) {
      return { error: t('variants.badStock', { name: values.join(' / ') }) };
    }
    variants.push({
      values,
      price: price === '' ? null : Math.round(Number(price.replace(',', '.')) * 100),
      vipPrice: vipPrice === '' ? null : Math.round(Number(vipPrice.replace(',', '.')) * 100),
      stock: stock === '' ? null : Number(stock),
      isActive: draft.active,
    });
  }
  if (!variants.some((v) => v.isActive)) return { error: t('variants.needOne') };
  return { options, variants };
}

/** Options (Color, Size…) and the price/stock of each combination. */
export function VariantsEditor({
  options,
  setOptions,
  drafts,
  setDrafts,
  basePrice,
  vipBasePrice,
  currency,
}: {
  options: OptionDraft[];
  setOptions: (next: OptionDraft[]) => void;
  drafts: Record<string, VariantDraft>;
  setDrafts: (next: Record<string, VariantDraft>) => void;
  basePrice: string;
  /** The product's VIP price as typed (placeholder for each variant's). */
  vipBasePrice: string;
  currency: string;
}): React.JSX.Element {
  const [bulkStock, setBulkStock] = useState('');
  const parsed = options
    .map((o) => ({ name: o.name.trim(), values: parseValues(o.values) }))
    .filter((o) => o.name !== '' && o.values.length > 0);
  const combos = parsed.length > 0 ? combinations(parsed) : [];
  const tooMany = combos.length > MAX_VARIANTS;

  const updateOption = (index: number, patch: Partial<OptionDraft>): void =>
    setOptions(options.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  const draftFor = (values: string[]): VariantDraft =>
    drafts[comboKey(values)] ?? { price: '', vipPrice: '', stock: '', active: true };
  const updateDraft = (values: string[], patch: Partial<VariantDraft>): void =>
    setDrafts({ ...drafts, [comboKey(values)]: { ...draftFor(values), ...patch } });

  return (
    <>
      <Section
        header={t('variants.options')}
        footer={t('variants.optionsFooter')}
      >
        {options.map((option, index) => (
          <div key={index}>
            <Input
              header={t('variants.optionName', { n: index + 1 })}
              placeholder={index === 0 ? t('variants.colorExample') : t('variants.sizeExample')}
              value={option.name}
              onChange={(e) => updateOption(index, { name: e.target.value })}
            />
            <Input
              header={t('variants.values')}
              placeholder={index === 0 ? t('variants.colorValuesExample') : 'S, M, L, XL'}
              value={option.values}
              onChange={(e) => updateOption(index, { values: e.target.value })}
            />
            <div style={{ padding: '0 16px 12px' }}>
              <Button
                size="s"
                mode="plain"
                onClick={() => setOptions(options.filter((_, i) => i !== index))}
              >
                {t('variants.removeOption')}
              </Button>
            </div>
          </div>
        ))}
        {options.length < MAX_OPTIONS && (
          <div style={{ padding: 16 }}>
            <Button
              stretched
              mode="bezeled"
              onClick={() => setOptions([...options, { name: '', values: '' }])}
            >
              {t('variants.addOption')}
            </Button>
          </div>
        )}
      </Section>

      {combos.length > 0 && (
        <Section
          header={t('variants.title', { count: combos.length })}
          footer={
            tooMany
              ? t('variants.limit', { max: MAX_VARIANTS })
              : t('variants.footer', { price: basePrice || '0', currency })
          }
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', padding: '8px 16px' }}>
            <div style={{ flex: 1 }}>
              <Input
                header={t('variants.bulkStock')}
                type="text"
                inputMode="numeric"
                placeholder={t('variants.bulkStockPlaceholder')}
                value={bulkStock}
                onChange={(e) => setBulkStock(e.target.value)}
              />
            </div>
            <Button
              size="s"
              mode="bezeled"
              disabled={bulkStock.trim() !== '' && !STOCK_RE.test(bulkStock.trim())}
              onClick={() => {
                const next = { ...drafts };
                for (const values of combos) {
                  next[comboKey(values)] = { ...draftFor(values), stock: bulkStock.trim() };
                }
                setDrafts(next);
              }}
            >
              {t('variants.apply')}
            </Button>
          </div>
          {!tooMany &&
            combos.map((values) => {
              const draft = draftFor(values);
              const priceBad = draft.price.trim() !== '' && !PRICE_RE.test(draft.price.trim());
              const vipBad =
                (draft.vipPrice ?? '').trim() !== '' && !PRICE_RE.test((draft.vipPrice ?? '').trim());
              const stockBad = draft.stock.trim() !== '' && !STOCK_RE.test(draft.stock.trim());
              return (
                <div
                  key={comboKey(values)}
                  style={{ opacity: draft.active ? 1 : 0.5, paddingBottom: 8 }}
                >
                  <Cell
                    after={
                      <Button
                        size="s"
                        mode={draft.active ? 'bezeled' : 'plain'}
                        onClick={() => updateDraft(values, { active: !draft.active })}
                      >
                        {draft.active ? t('variants.on') : t('variants.off')}
                      </Button>
                    }
                  >
                    <strong>{values.join(' / ')}</strong>
                  </Cell>
                  <div style={{ display: 'flex', gap: 8, padding: '0 8px' }}>
                    <div style={{ flex: 1 }}>
                      <Input
                        header={t('variants.price', { currency })}
                        type="text"
                        inputMode="decimal"
                        placeholder={basePrice || '—'}
                        status={priceBad ? 'error' : 'default'}
                        value={draft.price}
                        onChange={(e) => updateDraft(values, { price: e.target.value })}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Input
                        header={t('variants.stock')}
                        type="text"
                        inputMode="numeric"
                        placeholder="∞"
                        status={stockBad ? 'error' : 'default'}
                        value={draft.stock}
                        onChange={(e) => updateDraft(values, { stock: e.target.value })}
                      />
                    </div>
                  </div>
                  <div style={{ padding: '0 8px' }}>
                    <Input
                      header={t('variants.vipPrice', { currency })}
                      type="text"
                      inputMode="decimal"
                      placeholder={vipBasePrice || '—'}
                      status={vipBad ? 'error' : 'default'}
                      value={draft.vipPrice ?? ''}
                      onChange={(e) => updateDraft(values, { vipPrice: e.target.value })}
                    />
                  </div>
                </div>
              );
            })}
        </Section>
      )}
    </>
  );
}
