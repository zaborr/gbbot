import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Placeholder } from '@telegram-apps/telegram-ui';
import { t } from '../i18n/index.js';

/** Seconds before going back on its own. */
const BACK_AFTER = 5;

/**
 * Something could not load. It does not stay there: it goes back on its own
 * (home when there is nothing to go back to), unless the person tries again.
 */
export function ErrorView({ message }: { message: string }): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  // Opened straight on this page: nothing to go back to.
  const canGoBack = location.key !== 'default';
  const home = location.pathname === '/';
  const [left, setLeft] = useState<number | null>(home ? null : BACK_AFTER);

  const back = (): void => {
    if (canGoBack) navigate(-1);
    else navigate('/', { replace: true });
  };

  useEffect(() => {
    if (left === null) return;
    if (left <= 0) {
      back();
      return;
    }
    const timer = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  return (
    <Placeholder
      header={t('error.title')}
      description={
        left !== null ? (
          <>
            {message}
            <br />
            {t('error.goingBack', { seconds: left })}
          </>
        ) : (
          message
        )
      }
      action={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          <Button stretched onClick={() => window.location.reload()}>
            {t('error.retry')}
          </Button>
          {!home && (
            <Button stretched mode="bezeled" onClick={back}>
              {canGoBack ? t('error.back') : t('error.home')}
            </Button>
          )}
        </div>
      }
    >
      <span style={{ fontSize: 48 }}>😕</span>
    </Placeholder>
  );
}
