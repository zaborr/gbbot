import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import { Input } from '../../components/Field.js';
import type { Category } from '@tma-shop/shared';
import { api } from '../../api/client.js';
import { toSlug } from '../../lib/slug.js';
import { Loader } from '../../components/Loader.js';
import { t, tn } from '../../i18n/index.js';

/** Create, rename, reorder and delete the shop's categories. */
export function CategoriesSection({
  categories,
  loading,
  productCount,
  run,
  twoTap,
  tapLabel,
}: {
  categories: Category[];
  loading: boolean;
  productCount: (categoryId: string) => number;
  run: (action: () => Promise<unknown>) => Promise<void>;
  twoTap: (key: string, action: () => Promise<unknown>) => Promise<void>;
  tapLabel: (key: string, text: string, confirmText?: string) => string;
}): React.JSX.Element {
  const [newTitle, setNewTitle] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  const nextOrder = categories.reduce((max, c) => Math.max(max, c.sortOrder + 1), 0);

  const add = (): Promise<void> => {
    const title = newTitle.trim();
    return run(async () => {
      await api.adminCreateCategory({ slug: toSlug(title), title, sortOrder: nextOrder });
      setNewTitle('');
    });
  };

  const rename = (category: Category): Promise<void> =>
    run(async () => {
      await api.adminUpdateCategory(category.id, {
        slug: category.slug,
        title: renameTitle.trim(),
        sortOrder: category.sortOrder,
      });
      setRenaming(null);
    });

  /** Moves a category up/down by renumbering the whole list 0..n. */
  const move = (index: number, delta: -1 | 1): Promise<void> => {
    const order = [...categories];
    const target = index + delta;
    const a = order[index];
    const b = order[target];
    if (!a || !b) return Promise.resolve();
    order[index] = b;
    order[target] = a;
    return run(() =>
      Promise.all(
        order.map((c, i) =>
          c.sortOrder === i
            ? null
            : api.adminUpdateCategory(c.id, { slug: c.slug, title: c.title, sortOrder: i }),
        ),
      ),
    );
  };

  return (
    <Section
      header={t('categories.title')}
      footer={t('categories.footer')}
    >
      {loading && <Loader />}
      {!loading && categories.length === 0 && <Cell>{t('categories.empty')}</Cell>}
      {categories.map((category, index) =>
        renaming === category.id ? (
          <div key={category.id}>
            <Input
              header={t('categories.rename', { name: category.title })}
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, padding: '0 16px 12px' }}>
              <Button
                size="s"
                mode="filled"
                disabled={!renameTitle.trim()}
                onClick={() => void rename(category)}
              >
                {t('common.save')}
              </Button>
              <Button size="s" mode="plain" onClick={() => setRenaming(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <Cell
            key={category.id}
            subtitle={tn(productCount(category.id), 'count.products.one', 'count.products.other')}
            multiline
            description={
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                <Button
                  size="s"
                  mode="bezeled"
                  disabled={index === 0}
                  onClick={() => void move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="s"
                  mode="bezeled"
                  disabled={index === categories.length - 1}
                  onClick={() => void move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="s"
                  mode="bezeled"
                  onClick={() => {
                    setRenaming(category.id);
                    setRenameTitle(category.title);
                  }}
                >
                  {t('categories.renameButton')}
                </Button>
                <Button
                  size="s"
                  mode="plain"
                  onClick={() =>
                    void twoTap(`category:${category.id}`, () =>
                      api.adminDeleteCategory(category.id),
                    )
                  }
                >
                  {tapLabel(`category:${category.id}`, t('common.delete'), t('common.tapAgainToDelete'))}
                </Button>
              </div>
            }
          >
            {category.title}
          </Cell>
        ),
      )}
      <Input
        header={t('categories.new')}
        placeholder={t('categories.newPlaceholder')}
        value={newTitle}
        onChange={(e) => setNewTitle(e.target.value)}
      />
      <div style={{ padding: '0 16px 16px' }}>
        <Button stretched mode="bezeled" disabled={!newTitle.trim()} onClick={() => void add()}>
          {t('categories.add')}
        </Button>
      </div>
    </Section>
  );
}
