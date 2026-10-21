import { useState } from 'react';
import { Button, Cell, Section, Switch } from '@telegram-apps/telegram-ui';
import { Input, Textarea } from '../../components/Field.js';
import type { Category, Product, ProductInput } from '@tma-shop/shared';
import { api, ApiClientError } from '../../api/client.js';
import { toSlug } from '../../lib/slug.js';
import { ProductImage } from '../../components/ProductImage.js';
import { TOKENS, toMajor, type Token } from './common.js';
import {
  buildVariants,
  initialDrafts,
  initialOptions,
  VariantsEditor,
  type OptionDraft,
  type VariantDraft,
} from './VariantsEditor.js';
import { buildTiers, initialTiers, TiersEditor, type TierDraft } from './TiersEditor.js';
import { LangTabs, type TextLang } from '../../components/LangTabs.js';
import { t } from '../../i18n/index.js';

/** Create a product, or edit `product` when given. */
export function ProductForm({
  product,
  categories,
  defaultToken,
  onSaved,
  onCancel,
}: {
  product: Product | null;
  categories: Category[];
  defaultToken: Token;
  onSaved: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [title, setTitle] = useState(product?.title ?? '');
  const [slug, setSlug] = useState(product?.slug ?? '');
  const [price, setPrice] = useState(product ? toMajor(product.price) : '');
  const [vipPrice, setVipPrice] = useState(
    product && product.vipPrice !== null ? toMajor(product.vipPrice) : '',
  );
  const [token, setToken] = useState<string>(product?.currency ?? defaultToken);
  const [vipOnly, setVipOnly] = useState(product?.vipOnly ?? false);
  const [minQty, setMinQty] = useState(product && product.minQuantity > 1 ? String(product.minQuantity) : '');
  const [stock, setStock] = useState(
    product && product.stock !== null ? String(product.stock) : '',
  );
  const [imageUrl, setImageUrl] = useState(product?.imageUrl ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [titleEn, setTitleEn] = useState(product?.titleEn ?? '');
  const [descriptionEn, setDescriptionEn] = useState(product?.descriptionEn ?? '');
  const [textLang, setTextLang] = useState<TextLang>('es');
  const [categoryId, setCategoryId] = useState<string | null>(product?.categoryId ?? null);
  const [optionDrafts, setOptionDrafts] = useState<OptionDraft[]>(() => initialOptions(product));
  const [variantDrafts, setVariantDrafts] = useState<Record<string, VariantDraft>>(() =>
    initialDrafts(product),
  );
  const [tierDrafts, setTierDrafts] = useState<TierDraft[]>(() => initialTiers(product));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const image = imageUrl.trim();
  const imageInvalid = image !== '' && !/^https:\/\/\S+$/i.test(image);
  const vipValue = vipPrice.trim();
  const vipInvalid = vipValue !== '' && !/^\d+([.,]\d{1,2})?$/.test(vipValue);
  const stockValue = stock.trim();
  const stockInvalid = stockValue !== '' && !/^\d+$/.test(stockValue);
  const minValue = minQty.trim();
  const minInvalid =
    minValue !== '' && (!/^\d+$/.test(minValue) || Number(minValue) < 1 || Number(minValue) > 999);
  const built = buildVariants(optionDrafts, variantDrafts);
  const variantError = 'error' in built ? built.error : null;
  const withVariants = !('error' in built) && built.options.length > 0;
  const builtTiers = buildTiers(tierDrafts);
  const formError = variantError ?? ('error' in builtTiers ? builtTiers.error : null);

  const submit = async (): Promise<void> => {
    if ('error' in built) {
      setMessage(built.error);
      return;
    }
    if ('error' in builtTiers) {
      setMessage(builtTiers.error);
      return;
    }
    setBusy(true);
    setMessage(null);
    const input: ProductInput = {
      // A category deleted meanwhile falls back to "no category".
      categoryId: categories.some((c) => c.id === categoryId) ? categoryId : null,
      // Left empty, the slug is derived from the title.
      slug: slug.trim() || toSlug(title),
      title: title.trim(),
      description: description.trim(),
      // Empty = the Spanish text is shown in every language.
      titleEn: titleEn.trim() || null,
      descriptionEn: descriptionEn.trim() || null,
      // Typed in token units (12.90) and stored in cents.
      price: Math.round((Number(price.replace(',', '.')) || 0) * 100),
      vipPrice: vipValue === '' ? null : Math.round(Number(vipValue.replace(',', '.')) * 100),
      currency: token,
      imageUrl: image === '' ? null : image,
      // With variants, stock is set per variant.
      stock: withVariants || stockValue === '' ? null : Number(stockValue),
      isActive: product?.isActive ?? true,
      vipOnly,
      minQuantity: minValue === '' || minInvalid ? 1 : Number(minValue),
      options: built.options,
      variants: built.variants,
      priceTiers: builtTiers.tiers,
    };
    try {
      const saved = product
        ? await api.adminUpdateProduct(product.id, input)
        : await api.adminCreateProduct(input);
      setMessage(t(product ? 'productForm.saved' : 'productForm.created', { name: saved.title }));
      if (!product) {
        setTitle('');
        setSlug('');
        setPrice('');
        setVipPrice('');
        setVipOnly(false);
        setMinQty('');
        setStock('');
        setImageUrl('');
        setDescription('');
        setTitleEn('');
        setDescriptionEn('');
        setCategoryId(null);
        setOptionDrafts([]);
        setVariantDrafts({});
        setTierDrafts([]);
      }
      onSaved();
    } catch (err) {
      setMessage(err instanceof ApiClientError ? err.message : t('productForm.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Section header={product ? t('productForm.editTitle', { name: product.title }) : t('productForm.addTitle')}>
      <LangTabs value={textLang} onChange={setTextLang} englishDone={titleEn.trim() !== ''} />
      {textLang === 'es' ? (
        <Input header={t('productForm.title')} value={title} onChange={(e) => setTitle(e.target.value)} />
      ) : (
        <Input
          header={t('productForm.title')}
          placeholder={title}
          value={titleEn}
          onChange={(e) => setTitleEn(e.target.value)}
        />
      )}
      {textLang === 'es' ? (
        <Textarea
          header={t('productForm.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      ) : (
        <Textarea
          header={t('productForm.description')}
          placeholder={description}
          value={descriptionEn}
          onChange={(e) => setDescriptionEn(e.target.value)}
        />
      )}
    </Section>

    <Section header={t('productForm.presentation')}>
      <Input
        header={imageInvalid ? t('common.imageInvalid') : t('common.image')}
        type="url"
        placeholder="https://…/photo.jpg"
        status={imageInvalid ? 'error' : 'default'}
        value={imageUrl}
        onChange={(e) => setImageUrl(e.target.value)}
      />
      {image !== '' && !imageInvalid && (
        <div style={{ padding: '8px 16px' }}>
          <ProductImage url={image} alt={t('common.preview')} size={96} />
        </div>
      )}
      <Cell
        subtitle={t('productForm.category')}
        multiline
        description={
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <Button
              size="s"
              mode={categoryId === null ? 'filled' : 'bezeled'}
              onClick={() => setCategoryId(null)}
            >
              {t('productForm.none')}
            </Button>
            {categories.map((c) => (
              <Button
                key={c.id}
                size="s"
                mode={categoryId === c.id ? 'filled' : 'bezeled'}
                onClick={() => setCategoryId(c.id)}
              >
                {c.title}
              </Button>
            ))}
          </div>
        }
      >
        {categories.find((c) => c.id === categoryId)?.title ?? t('adminCatalog.noCategory')}
      </Cell>
    </Section>

    <Section header={t('productForm.priceSection')}>
      <Cell
        subtitle={t('productForm.currency')}
        after={
          <div style={{ display: 'flex', gap: 8 }}>
            {TOKENS.map((option) => (
              <Button
                key={option}
                size="s"
                mode={option === token ? 'filled' : 'bezeled'}
                onClick={() => setToken(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        }
      >
        {token}
      </Cell>
      <Input
        header={
          withVariants
            ? t('productForm.basePrice', { token })
            : t('productForm.price', { token })
        }
        type="text"
        inputMode="decimal"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <Input
        header={vipInvalid ? t('productForm.vipPriceInvalid') : t('productForm.vipPrice', { token })}
        type="text"
        inputMode="decimal"
        placeholder={t('productForm.vipPricePlaceholder')}
        status={vipInvalid ? 'error' : 'default'}
        value={vipPrice}
        onChange={(e) => setVipPrice(e.target.value)}
      />
      <Cell
        Component="label"
        after={<Switch checked={vipOnly} onChange={(e) => setVipOnly(e.target.checked)} />}
        subtitle={t('productForm.vipOnlyHint')}
        multiline
      >
        {t('productForm.vipOnly')}
      </Cell>
      <Input
        header={minInvalid ? t('productForm.minInvalid') : t('productForm.minQuantity')}
        type="text"
        inputMode="numeric"
        placeholder={t('productForm.minPlaceholder')}
        status={minInvalid ? 'error' : 'default'}
        value={minQty}
        onChange={(e) => setMinQty(e.target.value)}
      />
    </Section>

    {!withVariants && (
      <Section header={t('productForm.stockSection')}>
        <Input
          header={stockInvalid ? t('productForm.stockInvalid') : t('productForm.stock')}
          type="text"
          inputMode="numeric"
          status={stockInvalid ? 'error' : 'default'}
          value={stock}
          onChange={(e) => setStock(e.target.value)}
        />
      </Section>
    )}

    <TiersEditor
      tiers={tierDrafts}
      setTiers={setTierDrafts}
      basePrice={price}
      currency={token}
      withVariants={withVariants}
    />

    <VariantsEditor
      options={optionDrafts}
      setOptions={setOptionDrafts}
      drafts={variantDrafts}
      setDrafts={setVariantDrafts}
      basePrice={price}
      vipBasePrice={vipPrice}
      currency={token}
    />

    <Section header={t('productForm.advanced')} footer={t('productForm.slugFooter')}>
      <Input
        header={t('productForm.slug')}
        placeholder={title ? toSlug(title) : 'te-verde-sencha'}
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
      />
    </Section>

    <Section footer={formError ?? undefined}>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Button
          stretched
          loading={busy}
          disabled={
            !title.trim() ||
            imageInvalid ||
            vipInvalid ||
            (!withVariants && stockInvalid) ||
            minInvalid ||
            formError !== null
          }
          onClick={() => void submit()}
        >
          {product ? t('productForm.saveChanges') : t('productForm.create')}
        </Button>
        {product && (
          <Button stretched mode="plain" onClick={onCancel}>
            {t('productForm.cancelEditing')}
          </Button>
        )}
        {message && <Cell multiline>{message}</Cell>}
      </div>
    </Section>
    </>
  );
}
