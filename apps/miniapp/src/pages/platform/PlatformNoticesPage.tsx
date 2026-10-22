import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Cell, List, Placeholder, Section } from '@telegram-apps/telegram-ui';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Loader } from '../../components/Loader.js';
import { ErrorView } from '../../components/ErrorView.js';
import { PageTitle } from '../../components/PageTitle.js';
import { shopPath } from '../../providers/ShopProvider.js';
import { ErrorBanner, formatDate, useAdminActions } from '../admin/common.js';
import { useSession } from '../../providers/SessionProvider.js';
import { notifyNoticesSeen } from '../../lib/web.js';
import { t } from '../../i18n/index.js';

/**
 * Web administrators: what the bot tells the platform admins in Telegram (new
 * or deleted GBs, wallet and key changes, orders of GBs without a team).
 */
export function PlatformNoticesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { webRole } = useSession();
  // The inbox is shared: full platform accounts may clear it.
  const canDelete = webRole === 'platform';
  const [reloadKey, setReloadKey] = useState(0);
  const result = useAsync(() => api.platformNotices(), [reloadKey]);
  const actions = useAdminActions(() => setReloadKey((k) => k + 1));
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
      <ErrorBanner message={actions.error} />
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
              after={
                canDelete ? (
                  <Button
                    size="s"
                    mode="plain"
                    onClick={(e) => {
                      e.stopPropagation();
                      void actions.twoTap(`del-${notice.id}`, () =>
                        api.platformDeleteNotice(notice.id),
                      );
                    }}
                  >
                    {actions.tapLabel(`del-${notice.id}`, '🗑', t('notices.confirmDelete'))}
                  </Button>
                ) : notice.shopSlug ? (
                  '›'
                ) : undefined
              }
            >
              <span style={{ whiteSpace: 'pre-wrap' }}>{notice.text}</span>
            </Cell>
          ))}
        </Section>
      )}
      {canDelete && notices.length > 0 && (
        <Section footer={t('notices.deleteFooter')}>
          <div style={{ padding: 16 }}>
            <Button
              stretched
              mode="plain"
              onClick={() => void actions.twoTap('del-all', () => api.platformDeleteNotices())}
            >
              {actions.tapLabel('del-all', t('notices.deleteAll'))}
            </Button>
          </div>
        </Section>
      )}
    </List>
  );
}
