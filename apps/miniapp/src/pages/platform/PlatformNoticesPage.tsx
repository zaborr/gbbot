import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { shopPath } from '../../providers/ShopProvider.js';
import { formatDate } from '../admin/common.js';
import { notifyNoticesSeen } from '../../lib/web.js';
import { t } from '../../i18n/index.js';

/**
 * Web administrators: what the bot tells the platform admins in Telegram (new
 * or deleted GBs, wallet and key changes, orders of GBs without a team).
 */
export function PlatformNoticesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const result = useAsync(() => api.platformNotices(), []);
  const notices = result.data?.notices;

  // Opening the inbox marks everything in it as read.
  useEffect(() => {
    const newest = notices?.[0];
    if (!newest?.unread) return;
    void api
      .platformNoticesSeen(newest.id)
      .then(notifyNoticesSeen)
      .catch(() => undefined);
  }, [notices]);

  if (result.error) return <ErrorView message={result.error} />;
  if (!notices) return <Loader />;
  return (
    <List>
      <PageTitle title={t('notices.title')} />
      {notices.length === 0 ? (
        <Placeholder description={t('notices.empty')}>
          <span style={{ fontSize: 48 }}>📭</span>
        </Placeholder>
      ) : (
        <Section footer={t('notices.footer')}>
          {notices.map((notice) => (
            <Cell
              key={notice.id}
              multiline
              before={notice.unread ? '🔵' : undefined}
              subtitle={formatDate(notice.createdAt)}
              onClick={
                notice.shopSlug
                  ? () => navigate(shopPath(notice.shopSlug ?? '', '/admin'))
                  : undefined
              }
              after={notice.shopSlug ? '›' : undefined}
            >
              <span style={{ whiteSpace: 'pre-wrap' }}>{notice.text}</span>
            </Cell>
          ))}
        </Section>
      )}
    </List>
  );
}
