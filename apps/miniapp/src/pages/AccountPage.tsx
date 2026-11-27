import { List } from '@telegram-apps/telegram-ui';
import { AccountSections } from '../components/WebAccount.js';
import { PageTitle } from '../components/PageTitle.js';
import { isWebMode } from '../lib/web.js';
import { t } from '../i18n/index.js';

/** Their web account (username and password): to get in when the bot is down. */
export function AccountPage(): React.JSX.Element {
  return (
    <List>
      <PageTitle title={t('acct.myAccount')} />
      <AccountSections inTelegram={!isWebMode()} />
    </List>
  );
}
