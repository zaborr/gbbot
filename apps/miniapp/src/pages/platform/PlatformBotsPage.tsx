import { useState } from 'react';
import { Button, Cell, List, Section } from '@telegram-apps/telegram-ui';
import { BOT_TOKEN_RE, type BotInfo, type BotSwitchEntry, type BotsOverview } from '@tma-shop/shared';
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
  if (overview.loading && !overview.data) return <Loader />;
  if (overview.error) return <ErrorView message={overview.error} />;
  if (!overview.data) return <Loader />;
  return <BotsView overview={overview.data} onChanged={() => setReloadKey((k) => k + 1)} />;
}

function BotsView({ overview, onChanged }: { overview: BotsOverview; onChanged: () => void }): React.JSX.Element {
  const [token, setToken] = useState('');
  const [switched, setSwitched] = useState<BotInfo | null>(null);
  const actions = useAdminActions(onChanged);
  const tokenOk = BOT_TOKEN_RE.test(token.trim());
  const { active } = overview;

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

      {overview.bots.length > 0 && (
        <Section header={t('bots.others')}>
          {overview.bots.map((bot) => (
            <Cell
              key={bot.id}
              subtitle={
                bot.status === 'down' && bot.downAt
                  ? t('bots.downSince', { date: formatDate(bot.downAt) })
                  : t('bots.createdAt', { date: formatDate(bot.createdAt) })
              }
              after={
                <span className={`gb-chip ${bot.status === 'down' ? 'gb-chip--warn' : ''}`}>
                  {bot.status === 'down' ? t('bots.statusDown') : t('bots.statusReserve')}
                </span>
              }
            >
              {botName(bot)}
            </Cell>
          ))}
        </Section>
      )}

      <Section header={t('bots.history')}>
        {overview.history.length === 0 ? (
          <Cell multiline>{t('bots.historyEmpty')}</Cell>
        ) : (
          overview.history.map((entry: BotSwitchEntry) => (
            <Cell
              key={entry.id}
              subtitle={`${formatDate(entry.at)} · ${t(`bots.reason.${entry.reason}`)}`}
              multiline
            >
              {entry.from ? `${botName(entry.from)} → ${botName(entry.to)}` : botName(entry.to)}
            </Cell>
          ))
        )}
      </Section>
    </List>
  );
}
