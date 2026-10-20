import { Fragment } from 'react';
import type { OrganizerTag } from '@tma-shop/shared';
import { t } from '../i18n/index.js';

/**
 * "Organised by @ana, @luis": the GB's admins. Each @username opens their
 * Telegram profile; admins without one show their first name.
 */
export function OrganizedBy({
  organizers,
}: {
  organizers: readonly OrganizerTag[];
}): React.JSX.Element | null {
  if (organizers.length === 0) return null;
  return (
    <span className="tma-organized">
      {t('shops.organizedBy')}{' '}
      {organizers.map((o, i) => (
        <Fragment key={`${o.username ?? o.name}-${i}`}>
          {i > 0 && ', '}
          {o.username ? (
            <a
              href={`https://t.me/${o.username}`}
              target="_blank"
              rel="noreferrer"
              // Inside a tappable row: open the profile, not the GB.
              onClick={(event) => event.stopPropagation()}
            >
              @{o.username}
            </a>
          ) : (
            o.name
          )}
        </Fragment>
      ))}
    </span>
  );
}
