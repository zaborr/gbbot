import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { BLACKLIST_REASON_MAX, type BlacklistCheck, type BlacklistNote, type BlacklistView } from '@tma-shop/shared';
import { useAsync } from '../hooks/useAsync.js';
import { Loader } from './Loader.js';
import { ErrorView } from './ErrorView.js';
import { PageTitle } from './PageTitle.js';
import { Input, Textarea } from './Field.js';
import { ErrorBanner, useAdminActions } from '../pages/admin/common.js';
import { t, tn } from '../i18n/index.js';

export interface BlacklistApi {
  load: () => Promise<BlacklistView>;
  check: (who: string) => Promise<BlacklistCheck>;
  add: (who: string, removeData: boolean, reason: string, scope: 'shop' | 'platform') => Promise<BlacklistView>;
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
  initialWho = '',
  initialReason = '',
}: {
  title: string;
  footer: string;
  /** The platform list: what they have counts across every GB. */
  platform: boolean;
  api: BlacklistApi;
  initialWho?: string;
  initialReason?: string;
}): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const list = useAsync(() => api.load(), [reloadKey]);
  const [who, setWho] = useState(initialWho);
  const [reason, setReason] = useState(initialReason);
  // A GB's organiser: only in their GB, or in every GB.
  const [scope, setScope] = useState<'shop' | 'platform'>('shop');
  const [checked, setChecked] = useState<BlacklistCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));

  if (list.error) return <ErrorView message={list.error} />;
  if (!list.data) return <Loader />;
  const { people, pendingUsernames, notes, platform: everywhere } = list.data;
  const global = platform || scope === 'platform';
  const missingReason = global && !reason.trim();

  const run = (action: () => Promise<unknown>): void => {
    setBusy(true);
    void actions.run(action).finally(() => setBusy(false));
  };
  const block = (removeData: boolean): void =>
    run(async () => {
      await api.add(who, removeData, reason, platform ? 'platform' : scope);
      setWho('');
      setReason('');
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
            multiline
            subtitle={noteLine(notes[String(p.telegramId)]) ?? `id ${p.telegramId}`}
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
            multiline
            subtitle={[noteLine(notes[`@${u}`]), t('blacklist.notSeen')].filter(Boolean).join(' · ')}
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

      {everywhere && (
        <Section header={t('blacklist.everywhereTitle')} footer={t('blacklist.everywhereFooter')}>
          {everywhere.people.length === 0 && everywhere.pendingUsernames.length === 0 && (
            <Cell multiline>{t('blacklist.empty')}</Cell>
          )}
          {everywhere.people.map((p) => (
            <Cell key={p.telegramId} multiline subtitle={noteLine(everywhere.notes[String(p.telegramId)]) ?? `id ${p.telegramId}`}>
              {p.username ? `@${p.username}` : (p.firstName ?? String(p.telegramId))}
            </Cell>
          ))}
          {everywhere.pendingUsernames.map((u) => (
            <Cell
              key={u}
              multiline
              subtitle={[noteLine(everywhere.notes[`@${u}`]), t('blacklist.notSeen')].filter(Boolean).join(' · ')}
            >
              @{u}
            </Cell>
          ))}
        </Section>
      )}

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
            {checked.platformNote && (
              <Cell multiline subtitle={noteLine(checked.platformNote) ?? undefined}>
                {t('blacklist.alreadyEverywhere')}
              </Cell>
            )}
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
              {!platform && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    stretched
                    size="s"
                    mode={scope === 'shop' ? 'filled' : 'bezeled'}
                    onClick={() => setScope('shop')}
                  >
                    {t('blacklist.scopeShop')}
                  </Button>
                  <Button
                    stretched
                    size="s"
                    mode={scope === 'platform' ? 'filled' : 'bezeled'}
                    disabled={Boolean(checked.platformNote)}
                    onClick={() => setScope('platform')}
                  >
                    {t('blacklist.scopePlatform')}
                  </Button>
                </div>
              )}
              <Textarea
                header={global ? t('blacklist.reasonNeeded') : t('blacklist.reason')}
                value={reason}
                maxLength={BLACKLIST_REASON_MAX}
                status={missingReason && reason !== '' ? 'error' : 'default'}
                onChange={(e) => setReason(e.target.value)}
              />
              {!platform && (
                <div style={{ fontSize: 14, lineHeight: '18px', color: 'var(--tgui--hint_color)' }}>
                  {scope === 'platform' ? t('blacklist.scopePlatformHint') : t('blacklist.scopeShopHint')}
                </div>
              )}
              <Button stretched loading={busy} disabled={missingReason} onClick={() => block(false)}>
                {has ? t('blacklist.blockKeep') : t('blacklist.block')}
              </Button>
              {has && (
                <Button stretched mode="bezeled" loading={busy} disabled={missingReason} onClick={() => block(true)}>
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

/** "Reason · by @who · date", when there is a note. */
function noteLine(note: BlacklistNote | undefined | null): string | null {
  if (!note || !note.reason) return null;
  const parts = [note.reason];
  if (note.by) parts.push(t('blacklist.by', { who: note.by }));
  if (note.at) parts.push(new Date(note.at).toLocaleDateString());
  return parts.join(' · ');
}
