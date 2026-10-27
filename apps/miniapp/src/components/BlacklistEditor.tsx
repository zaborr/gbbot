import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import type { BlacklistCheck, BlacklistView } from '@tma-shop/shared';
import { useAsync } from '../hooks/useAsync.js';
import { Loader } from './Loader.js';
import { ErrorView } from './ErrorView.js';
import { PageTitle } from './PageTitle.js';
import { Input } from './Field.js';
import { ErrorBanner, useAdminActions } from '../pages/admin/common.js';
import { t, tn } from '../i18n/index.js';

export interface BlacklistApi {
  load: () => Promise<BlacklistView>;
  check: (who: string) => Promise<BlacklistCheck>;
  add: (who: string, removeData: boolean) => Promise<BlacklistView>;
  remove: (who: string) => Promise<BlacklistView>;
}

/**
 * A blacklist (of a GB or of the whole platform): who is in it, and adding
 * someone after seeing what they have, so the admin decides what happens to it.
 */
export function BlacklistEditor({
  title,
  footer,
  platform,
  api,
}: {
  title: string;
  footer: string;
  /** The platform list: what they have counts across every GB. */
  platform: boolean;
  api: BlacklistApi;
}): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.load(), [reloadKey]);
  const [who, setWho] = useState('');
  const [checked, setChecked] = useState<BlacklistCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));

  if (list.error) return <ErrorView message={list.error} />;
  if (!list.data) return <Loader />;
  const { people, pendingUsernames } = list.data;

  const run = (action: () => Promise<unknown>): void => {
    setBusy(true);
    void actions.run(action).finally(() => setBusy(false));
  };
  const block = (removeData: boolean): void =>
    run(async () => {
      await api.add(who, removeData);
      setWho('');
      setChecked(null);
    });
  const has = checked && (checked.cartItems > 0 || checked.unpaidOrders > 0);

  return (
    <List>
      <PageTitle title={title} />
      <ErrorBanner message={actions.error} />

      <Section footer={footer}>
        {people.length === 0 && pendingUsernames.length === 0 && (
          <Cell multiline>{t('blacklist.empty')}</Cell>
        )}
        {people.map((p) => (
          <Cell
            key={p.telegramId}
            subtitle={`id ${p.telegramId}`}
            after={
              <Button
                size="s"
                mode="plain"
                onClick={() =>
                  void actions.twoTap(`rm-${p.telegramId}`, () => api.remove(String(p.telegramId)))
                }
              >
                {actions.tapLabel(`rm-${p.telegramId}`, t('blacklist.remove'))}
              </Button>
            }
          >
            {p.username ? `@${p.username}` : (p.firstName ?? String(p.telegramId))}
          </Cell>
        ))}
        {pendingUsernames.map((u) => (
          <Cell
            key={u}
            subtitle={t('blacklist.notSeen')}
            after={
              <Button
                size="s"
                mode="plain"
                onClick={() => void actions.twoTap(`rm-${u}`, () => api.remove(u))}
              >
                {actions.tapLabel(`rm-${u}`, t('blacklist.remove'))}
              </Button>
            }
          >
            @{u}
          </Cell>
        ))}
      </Section>

      <Section header={t('blacklist.addTitle')} footer={t('blacklist.addFooter')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
          <Input
            header={t('blacklist.who')}
            value={who}
            autoCapitalize="none"
            onChange={(e) => {
              setWho(e.target.value);
              setChecked(null);
            }}
          />
          {!checked && (
            <Button
              stretched
              mode="bezeled"
              loading={busy}
              disabled={!who.trim()}
              onClick={() => run(async () => setChecked(await api.check(who)))}
            >
              {t('blacklist.check')}
            </Button>
          )}
        </div>
        {checked && (
          <>
            <Cell multiline subtitle={checked.telegramId === null ? t('blacklist.notSeen') : undefined}>
              <strong>{checked.label}</strong>
            </Cell>
            <Cell multiline>
              {[
                checked.cartItems > 0
                  ? tn(checked.cartItems, 'blacklist.cart.one', 'blacklist.cart.other')
                  : null,
                checked.unpaidOrders > 0
                  ? tn(checked.unpaidOrders, 'blacklist.unpaid.one', 'blacklist.unpaid.other')
                  : null,
                checked.paidOrders > 0
                  ? tn(checked.paidOrders, 'blacklist.paid.one', 'blacklist.paid.other')
                  : null,
                platform && checked.shops > 0
                  ? tn(checked.shops, 'blacklist.inShops.one', 'blacklist.inShops.other')
                  : null,
              ]
                .filter(Boolean)
                .join(' · ') || t('blacklist.nothing')}
            </Cell>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
              <Button stretched loading={busy} onClick={() => block(false)}>
                {has ? t('blacklist.blockKeep') : t('blacklist.block')}
              </Button>
              {has && (
                <Button stretched mode="bezeled" loading={busy} onClick={() => block(true)}>
                  {t('blacklist.blockDelete')}
                </Button>
              )}
            </div>
          </>
        )}
      </Section>
    </List>
  );
}
