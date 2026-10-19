import { AppRoot, Placeholder } from '@telegram-apps/telegram-ui';
import { useAppearance } from '../hooks/useAppearance.js';
import { t } from '../i18n/index.js';

/** Shown when the app is opened outside a supported Telegram environment. */
export function EnvUnsupported(): React.JSX.Element {
  const appearance = useAppearance();
  return (
    <AppRoot
      appearance={appearance}
      className={appearance === 'dark' ? 'tma-root tma-dark' : 'tma-root'}
    >
      <Placeholder header={t('env.title')} description={t('env.description')}>
        <span style={{ fontSize: 56 }}>📱</span>
      </Placeholder>
    </AppRoot>
  );
}
