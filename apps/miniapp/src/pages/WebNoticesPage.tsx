import { Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { Loader } from '../components/Loader.js';
import { ErrorView } from '../components/ErrorView.js';
import { formatDateTime } from '../lib/format.js';
import { t } from '../i18n/index.js';

/** A customer on the web: what the bot told them (kept even while the bot is down). */
export function WebNoticesPage(): React.JSX.Element {
  const notices = useAsync(() => api.myNotices(), []);
  if (notices.loading && !notices.data) return <Loader />;
  if (notices.error) return <ErrorView message={notices.error} />;
  const list = notices.data ?? [];
  if (list.length === 0) {
    return (
      <Placeholder header={t('webKey.noticesEmpty')} description={t('webKey.noticesEmptyHint')}>
        <span style={{ fontSize: 48 }}>🔔</span>
      </Placeholder>
    );
  }
  return (
    <List>
      <Section header={t('webKey.notices')}>
        {list.map((n) => (
          <Cell key={n.id} multiline subtitle={formatDateTime(n.at)}>
            <span style={{ whiteSpace: 'pre-wrap' }}>{n.text}</span>
          </Cell>
        ))}
      </Section>
    </List>
  );
}
