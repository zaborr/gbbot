import { Cell, Section } from '@telegram-apps/telegram-ui';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { testingLive } from '../lib/testingState.js';
import { t } from '../i18n/index.js';

/**
 * The way to the testing screen (catalog, orders): how many testings one is
 * in and how many one can still join. Nothing when there is no testing.
 */
export function TestingEntry({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const testings = useAsync(() => api.getTestings(), []);
  const all = testings.data ?? [];
  const inNow = all.filter((x) => x.joined && x.status !== 'settled' && x.status !== 'cancelled').length;
  const canJoin = all.filter((x) => !x.joined && testingLive(x)).length;
  if (inNow === 0 && canJoin === 0) return null;
  const parts = [
    inNow > 0 ? t('testingHub.entryIn', { count: inNow }) : null,
    canJoin > 0 ? t('testingHub.entryCan', { count: canJoin }) : null,
  ].filter(Boolean);
  return (
    <Section>
      <Cell multiline onClick={onOpen} after="›" subtitle={parts.join(' · ')}>
        {t('testingHub.entry')}
      </Cell>
    </Section>
  );
}
