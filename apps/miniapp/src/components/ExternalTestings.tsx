import { useState } from 'react';
import { Button, Cell, Section, Switch } from '@telegram-apps/telegram-ui';
import type { Order } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { formatPrice } from '../lib/format.js';
import { useSession } from '../providers/SessionProvider.js';
import { t } from '../i18n/index.js';

/**
 * Testings open to people from outside (who bought it elsewhere): joining
 * makes an order of only the fee (nothing at all when it is 0).
 */
export function ExternalTestings({
  orders,
  onJoined,
}: {
  /** Their orders here: what they bought here joins from that order instead. */
  orders: readonly Order[];
  onJoined: (orderId: string) => void;
}): React.JSX.Element | null {
  const testings = useAsync(() => api.getTestings(), []);
  const { user } = useSession();
  const [volunteer, setVolunteer] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boughtHere = (productId: string, variantId: string | null): boolean =>
    orders.some(
      (o) =>
        o.status !== 'cancelled' &&
        o.items.some((i) => i.productId === productId && (variantId === null || i.variantId === variantId)),
    );
  const offers = (testings.data ?? []).filter(
    (x) => x.externalOpen && !x.joined && !boughtHere(x.productId, x.variantId),
  );
  if (offers.length === 0) return null;

  const join = (testingId: string): void => {
    setBusy(testingId);
    setError(null);
    void api
      .joinExternalTesting(testingId, volunteer, user?.username ?? null)
      .then(({ orderId }) => onJoined(orderId))
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : t('error.title')))
      .finally(() => setBusy(null));
  };

  return (
    <Section header={t('testing.externalTitle')} footer={t('testing.externalFooter')}>
      {offers.map((x) => (
        <Cell
          key={x.id}
          multiline
          subtitle={[
            x.lab,
            x.donationsUntil ? t('testing.joinUntil', { date: new Date(x.donationsUntil).toLocaleString() }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          after={
            <Button size="s" mode="bezeled" loading={busy === x.id} onClick={() => join(x.id)}>
              {x.contribution > 0
                ? t('testing.participate', { amount: formatPrice(x.contribution, x.currency) })
                : t('testing.participateFree')}
            </Button>
          }
        >
          {x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle}
        </Cell>
      ))}
      <Cell
        Component="label"
        after={<Switch checked={volunteer} onChange={(e) => setVolunteer(e.target.checked)} />}
        subtitle={t('testing.externalVolunteerHint')}
        multiline
      >
        {t('testing.volunteer')}
      </Cell>
      {error && <Cell multiline>{error}</Cell>}
    </Section>
  );
}
