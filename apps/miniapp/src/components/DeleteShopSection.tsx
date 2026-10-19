import { useState } from 'react';
import { Button, Cell, Section } from '@telegram-apps/telegram-ui';
import type { ShopContents } from '../api/client.js';
import { Input } from './Field.js';
import { ErrorBanner, useAdminActions } from '../pages/admin/common.js';
import { t } from '../i18n/index.js';

type DeleteStep = 'idle' | 'review' | 'type' | 'final';

/**
 * Deleting a shop with everything in it, in several deliberate steps: see what
 * goes, type the shop's name, then tap the final button twice.
 */
export function DeleteShopSection({
  shop,
  loadContents,
  deleteAll,
  onDeleted,
}: {
  shop: { name: string };
  loadContents: () => Promise<ShopContents>;
  deleteAll: (confirmName: string) => Promise<unknown>;
  onDeleted: () => void;
}): React.JSX.Element {
  const actions = useAdminActions(() => undefined);
  const [step, setStep] = useState<DeleteStep>('idle');
  const [contents, setContents] = useState<ShopContents | null>(null);
  const [typed, setTyped] = useState('');
  const nameMatches = typed.trim() === shop.name.trim();
  const danger: React.CSSProperties = { color: 'var(--tgui--destructive_text_color)' };

  const cancel = (): void => {
    setStep('idle');
    setTyped('');
  };
  const cancelButton = (
    <Button stretched mode="bezeled" onClick={cancel}>
      {t('deleteShop.keep')}
    </Button>
  );

  return (
    <>
    <ErrorBanner message={actions.error} />
    <Section header={t('deleteShop.zone')}>
      {step === 'idle' && (
        <div style={{ padding: 16 }}>
          <Button
            stretched
            mode="plain"
            onClick={() =>
              void actions.run(async () => {
                setContents(await loadContents());
                setStep('review');
              })
            }
          >
            <span style={danger}>{t('deleteShop.start')}</span>
          </Button>
        </div>
      )}

      {step === 'review' && contents && (
        <>
          <Cell multiline style={danger}>
            {t('deleteShop.step1', { name: shop.name })}
          </Cell>
          <Cell after={String(contents.orders)}>{t('deleteShop.orders')}</Cell>
          <Cell after={String(contents.products)}>{t('deleteShop.products')}</Cell>
          <Cell after={String(contents.categories)}>{t('categories.title')}</Cell>
          <Cell after={String(contents.carts)}>{t('deleteShop.carts')}</Cell>
          <Cell multiline>{t('deleteShop.cannotUndo')}</Cell>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
            <Button stretched mode="plain" onClick={() => setStep('type')}>
              <span style={danger}>{t('deleteShop.understand')}</span>
            </Button>
            {cancelButton}
          </div>
        </>
      )}

      {step === 'type' && (
        <>
          <Cell multiline style={danger}>
            {t('deleteShop.step2')}
          </Cell>
          <Input
            header={t('deleteShop.nameField', { name: shop.name })}
            placeholder={shop.name}
            status={typed && !nameMatches ? 'error' : 'default'}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
            <Button
              stretched
              mode="plain"
              disabled={!nameMatches}
              onClick={() => setStep('final')}
            >
              <span style={nameMatches ? danger : undefined}>{t('deleteShop.continue')}</span>
            </Button>
            {cancelButton}
          </div>
        </>
      )}

      {step === 'final' && (
        <>
          <Cell multiline style={danger}>
            {t('deleteShop.step3')}
          </Cell>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
            <Button
              stretched
              mode="filled"
              style={{ background: 'var(--tgui--destructive_text_color)' }}
              onClick={() =>
                void actions.twoTap('delete-forever', async () => {
                  await deleteAll(typed);
                  onDeleted();
                })
              }
            >
              {actions.tapLabel(
                'delete-forever',
                t('deleteShop.forever'),
                t('deleteShop.foreverConfirm'),
              )}
            </Button>
            {cancelButton}
          </div>
        </>
      )}
    </Section>
    </>
  );
}
