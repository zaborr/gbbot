import { Placeholder } from '@telegram-apps/telegram-ui';
import { t } from '../i18n/index.js';

export function ErrorView({ message }: { message: string }): React.JSX.Element {
  return (
    <Placeholder header={t('error.title')} description={message}>
      <span style={{ fontSize: 48 }}>😕</span>
    </Placeholder>
  );
}
