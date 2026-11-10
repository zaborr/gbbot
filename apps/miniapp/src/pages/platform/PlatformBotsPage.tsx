import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import {
  BOT_TOKEN_RE,
  type BotInfo,
  type BotSwitchEntry,
  type BotsOverview,
  type CreatorAccountInfo,
} from '@tma-shop/shared';
import { Input } from '../../components/Field.js';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../providers/SessionProvider.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { ErrorBanner, formatDate, useAdminActions } from '../admin/common.js';
import { t } from '../../i18n/index.js';

/** Platform super-admin: the bot the platform answers as, and switching to another one. */
export function PlatformBotsPage(): React.JSX.Element {
  const { isSuperAdmin } = useSession();
  if (!isSuperAdmin) return <ErrorView message={t('platform.only')} />;
  return <Bots />;
}

const botName = (bot: { id: number; username: string | null }): string =>
  bot.username ? `@${bot.username}` : `#${bot.id}`;

function Bots(): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const overview = useAsync(() => api.platformGetBots(), [reloadKey]);
  const accounts = useAsync(() => api.platformCreatorAccounts(), [reloadKey]);
  if (overview.loading && !overview.data) return <Loader />;
  if (overview.error) return <ErrorView message={overview.error} />;
  if (!overview.data) return <Loader />;
  return (
    <BotsView
      overview={overview.data}
      accounts={accounts.data ?? []}
      onChanged={() => setReloadKey((k) => k + 1)}
    />
  );
}

export const ACCOUNT_CHIP: Record<CreatorAccountInfo['status'], { className: string; key: 'creator.statusOk' | 'creator.statusLogin' | 'creator.statusClosed' }> = {
  ok: { className: 'gb-chip--info', key: 'creator.statusOk' },
  login: { className: 'gb-chip--warn', key: 'creator.statusLogin' },
  closed: { className: 'gb-chip--warn', key: 'creator.statusClosed' },
};

function BotsView({
  overview,
  accounts,
  onChanged,
}: {
  overview: BotsOverview;
  accounts: CreatorAccountInfo[];
  onChanged: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [switched, setSwitched] = useState<BotInfo | null>(null);
  const [menuSet, setMenuSet] = useState<string | null>(null);
  const actions = useAdminActions(onChanged);
  const tokenOk = BOT_TOKEN_RE.test(token.trim());
  const { active } = overview;
  const spares = overview.bots.filter((bot) => bot.status === 'reserve');
  const down = overview.bots.filter((bot) => bot.status === 'down');

  const change = (): void =>
    void actions.twoTap('switch', async () => {
      const bot = await api.platformSwitchBot(token.trim());
      setSwitched(bot);
      setToken('');
    });

  return (
    <List>
      <ErrorBanner message={actions.error} />

      <Section header={t('bots.active')} footer={t('bots.activeFooter')}>
        {active ? (
          <Cell
            subtitle={active.activatedAt ? t('bots.since', { date: formatDate(active.activatedAt) }) : undefined}
            after={
              <span className={`gb-chip ${overview.working ? 'gb-chip--info' : 'gb-chip--warn'}`}>
                {overview.working ? t('bots.working') : t('bots.notWorking')}
              </span>
            }
            multiline
          >
            {botName(active)}
          </Cell>
        ) : (
          <Cell multiline>{t('bots.noActive')}</Cell>
        )}
        <Cell
          multiline
          subtitle={
            overview.watch.problem
              ? t('bots.watchProblem', { problem: overview.watch.problem })
              : overview.watch.checkedAt
                ? t('bots.watchLast', { date: formatDate(overview.watch.checkedAt) })
                : t('bots.watchNotYet')
          }
        >
          {t('bots.watch')}
        </Cell>
        {overview.working && (
          <Cell
            multiline
            subtitle={
              menuSet && menuSet !== overview.menuUrl
                ? t('bots.menuDone', { url: menuSet })
                : (overview.menuUrl ?? t('bots.noMenu'))
            }
            after={
              <Button
                size="s"
                mode="bezeled"
                onClick={() => void actions.run(async () => setMenuSet((await api.platformSetMenuButton()).menuUrl))}
              >
                {overview.menuUrl ? t('bots.menuReset') : t('bots.menuSet')}
              </Button>
            }
          >
            {t('bots.menu')}
          </Cell>
        )}
      </Section>

      {switched && (
        <Section>
          <Cell multiline style={{ color: '#31b545' }}>
            {t('bots.switchedNow', { bot: botName(switched) })}
          </Cell>
        </Section>
      )}

      <Section header={t('bots.switchTitle')} footer={t('bots.switchFooter')}>
        <Input
          header={t('bots.token')}
          placeholder="123456789:AA…"
          autoComplete="off"
          spellCheck={false}
          status={token.trim() !== '' && !tokenOk ? 'error' : 'default'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div style={{ padding: 16 }}>
          <Button stretched disabled={!tokenOk} onClick={change}>
            {actions.tapLabel('switch', t('bots.switch'))}
          </Button>
        </div>
      </Section>

      <Section header={t('bots.reserveTitle')} footer={t('bots.reserveFooter')}>
        {spares.length === 0 && <Cell multiline>{t('bots.noReserve')}</Cell>}
        {spares.map((bot) => (
          <div key={bot.id} className="gb-bot-row">
            <Cell subtitle={t('bots.createdAt', { date: formatDate(bot.createdAt) })} multiline>
              {botName(bot)}
            </Cell>
            <div className="gb-bot-row-actions">
              <Button size="s" mode="bezeled" onClick={() => void actions.twoTap(`use-${bot.id}`, () => api.platformUseReserve(bot.id))}>
                {actions.tapLabel(`use-${bot.id}`, t('bots.useReserve'))}
              </Button>
              <Button
                size="s"
                mode="plain"
                onClick={() => void actions.twoTap(`retire-${bot.id}`, () => api.platformRetireBot(bot.id))}
              >
                {actions.tapLabel(`retire-${bot.id}`, t('bots.retire'))}
              </Button>
            </div>
          </div>
        ))}
        <Cell onClick={() => void actions.run(() => api.platformCreateReserve())}>{t('bots.createReserve')}</Cell>
        <Cell onClick={() => navigate('/platform/bots/settings')} after="›">
          {t('bots.settings')}
        </Cell>
      </Section>

      {down.length > 0 && (
        <Section header={t('bots.downTitle')}>
          {down.map((bot) => (
            <Cell
              key={bot.id}
              subtitle={bot.downAt ? t('bots.downSince', { date: formatDate(bot.downAt) }) : undefined}
              after={
                <Button
                  size="s"
                  mode="plain"
                  onClick={() => void actions.twoTap(`retire-${bot.id}`, () => api.platformRetireBot(bot.id))}
                >
                  {actions.tapLabel(`retire-${bot.id}`, t('bots.forget'))}
                </Button>
              }
            >
              {botName(bot)}
            </Cell>
          ))}
        </Section>
      )}

      <Section header={t('creator.title')} footer={t('creator.footer')}>
        {accounts.map((account) => (
          <Cell
            key={account.id}
            onClick={() => navigate(`/platform/bots/accounts/${account.id}`)}
            subtitle={account.phone}
            after={
              <span className={`gb-chip ${ACCOUNT_CHIP[account.status].className}`}>
                {t(ACCOUNT_CHIP[account.status].key)}
              </span>
            }
          >
            {account.username ? `@${account.username}` : (account.firstName ?? t('creator.unnamed'))}
          </Cell>
        ))}
        <Cell onClick={() => navigate('/platform/bots/accounts/new')}>{t('creator.add')}</Cell>
      </Section>

      <Section header={t('bots.history')}>
        {overview.history.length === 0 ? (
          <Cell multiline>{t('bots.historyEmpty')}</Cell>
        ) : (
          overview.history.map((entry: BotSwitchEntry) => (
            <Cell
              key={entry.id}
              subtitle={[
                `${formatDate(entry.at)} · ${t(`bots.reason.${entry.reason}`)}`,
                entry.notices &&
                  t('bots.noticesSummary', {
                    admins: entry.notices.admins.sent,
                    channel: entry.notices.channel ? (entry.notices.channel.ok ? '✅' : '❌') : '—',
                    groups: `${entry.notices.groups.ok}/${entry.notices.groups.ok + entry.notices.groups.failed}`,
                  }),
              ]
                .filter(Boolean)
                .join(' · ')}
              multiline
            >
              {entry.from ? `${botName(entry.from)} → ${botName(entry.to)}` : botName(entry.to)}
            </Cell>
          ))
        )}
        {overview.history.length > 0 && (
          <Cell onClick={() => void actions.twoTap('clear-history', () => api.platformClearBotHistory())}>
            <span style={{ color: 'var(--tgui--destructive_text_color, #e53935)' }}>
              {actions.tapLabel('clear-history', t('bots.clearHistory'))}
            </span>
          </Cell>
        )}
      </Section>
    </List>
  );
}
