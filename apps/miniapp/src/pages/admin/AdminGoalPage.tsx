import { List } from '@telegram-apps/telegram-ui';
import { GoalSection } from './GoalSection.js';
import { AdminOnly } from './common.js';
import { PageTitle } from '../../components/PageTitle.js';
import { t } from '../../i18n/index.js';

/** The GB's minimum: the amount its orders must reach, and its progress bar. */
export function AdminGoalPage(): React.JSX.Element {
  return (
    <AdminOnly>
      <List>
        <PageTitle title={t('adminHome.goal')} />
        <GoalSection />
      </List>
    </AdminOnly>
  );
}
