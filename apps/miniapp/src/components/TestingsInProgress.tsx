import { useState } from 'react';
import { Button, Cell, Section, Switch } from '@telegram-apps/telegram-ui';
import type { Order, Testing } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { formatPrice } from '../lib/format.js';
import { sharePercent, testingLive as joinable, testingState } from '../lib/testingState.js';
import { useSession } from '../providers/SessionProvider.js';
import { TestingBar } from './TestingCard.js';
import { t } from '../i18n/index.js';

/** Its extra round asks something of those in (signing up, paying, going on). */
const extraLive = (x: Testing): boolean => Boolean(x.extra && x.extra.stage !== 'done');

type Action =
  | { kind: 'in'; orderId: string }
  | { kind: 'order'; orderId: string }
  | { kind: 'see'; orderId: string }
  | { kind: 'outside' };

/**
 * The testings going on, at the top of «My orders» (where a closed GB opens):
 * how far each is and, for each person, what they can do: join with the
 * order they bought it in, join from outside, or go to the order they are in
 * with (to give, or for the extra round).
 */
export function TestingsInProgress({
  orders,
  onOrder,
  onChanged,
}: {
  orders: readonly Order[];
  onOrder: (orderId: string) => void;
  onChanged: () => void;
}): React.JSX.Element | null {
  const testings = useAsync(() => api.getTestings(), []);
  const { user } = useSession();
  const [volunteer, setVolunteer] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const withProduct = (x: Testing): Order[] =>
    orders.filter(
      (o) =>
        o.status !== 'cancelled' &&
        o.items.some((i) => i.productId === x.productId && (x.variantId === null || i.variantId === x.variantId)),
    );
  /** The order they took part with: from outside, or one with the product. */
  const inWith = (x: Testing): Order | undefined =>
    withProduct(x)[0] ?? orders.find((o) => o.externalTestingId === x.id && o.status !== 'cancelled');

  const actionOf = (x: Testing): Action | null => {
    if (x.joined) {
      const order = inWith(x);
      return order ? { kind: 'in', orderId: order.id } : null;
    }
    if (!joinable(x) || x.exempt) return null;
    const mine = withProduct(x);
    if (mine.length > 0) {
      // Not while a payment is being checked; sent ones only for a testing made after closing.
      const fits = mine.find(
        (o) =>
          o.currency === x.currency &&
          (o.status === 'paid' ||
            (o.status === 'pending' && o.amountSubmitted === 0) ||
            (x.posterior && (o.status === 'shipped' || o.status === 'fulfilled'))),
      );
      return fits ? { kind: 'order', orderId: fits.id } : { kind: 'see', orderId: mine[0]!.id };
    }
    return x.externalOpen ? { kind: 'outside' } : null;
  };

  const rows = (testings.data ?? [])
    .filter((x) => joinable(x) || (x.joined && extraLive(x)))
    .map((x) => ({ x, action: actionOf(x) }))
    .filter((r): r is { x: Testing; action: Action } => r.action !== null);
  if (rows.length === 0) return null;
  const joining = rows.some((r) => r.action.kind === 'order' || r.action.kind === 'outside');

  const run = (id: string, act: () => Promise<string>): void => {
    setBusy(id);
    setError(null);
    void act()
      .then((orderId) => {
        onChanged();
        onOrder(orderId);
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : t('error.title')))
      .finally(() => setBusy(null));
  };

  const fee = (x: Testing): string =>
    x.contribution > 0
      ? t('testing.participate', { amount: formatPrice(x.contribution, x.currency) })
      : t('testing.participateFree');

  const button = (x: Testing, action: Action): React.JSX.Element => {
    switch (action.kind) {
      case 'in':
        return (
          <Button size="s" mode="bezeled" onClick={() => onOrder(action.orderId)}>
            {extraLive(x) ? t('testing.liveExtra') : t('testing.liveIn')}
          </Button>
        );
      case 'see':
        return (
          <Button size="s" mode="bezeled" onClick={() => onOrder(action.orderId)}>
            {t('testing.liveSee')}
          </Button>
        );
      case 'order':
        return (
          <Button
            size="s"
            mode="bezeled"
            loading={busy === x.id}
            onClick={() =>
              run(x.id, () => api.addOrderTesting(action.orderId, x.id, volunteer).then(() => action.orderId))
            }
          >
            {fee(x)}
          </Button>
        );
      case 'outside':
        return (
          <Button
            size="s"
            mode="bezeled"
            loading={busy === x.id}
            onClick={() =>
              run(x.id, () =>
                api.joinExternalTesting(x.id, volunteer, user?.username ?? null).then((r) => r.orderId),
              )
            }
          >
            {fee(x)}
          </Button>
        );
    }
  };

  return (
    <Section
      header={t('testing.liveTitle')}
      footer={rows.some((r) => r.action.kind === 'outside') ? t('testing.externalFooter') : undefined}
    >
      {rows.map(({ x, action }) => {
        const { next } = testingState(x);
        const until =
          x.status === 'closed' && x.donationsUntil
            ? t('testing.joinUntil', { date: new Date(x.donationsUntil).toLocaleString() })
            : null;
        return (
          <div key={x.id}>
            <Cell
              multiline
              subtitle={[
                x.lab,
                next ? t('testing.shareCovered', { percent: sharePercent(next) }) : t('testing.allTiers'),
                until,
              ]
                .filter(Boolean)
                .join(' · ')}
              after={button(x, action)}
            >
              {x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle}
            </Cell>
            <div style={{ padding: '0 16px 12px' }}>
              <TestingBar testing={x} />
            </div>
          </div>
        );
      })}
      {joining && (
        <Cell
          Component="label"
          after={<Switch checked={volunteer} onChange={(e) => setVolunteer(e.target.checked)} />}
          subtitle={t('testing.externalVolunteerHint')}
          multiline
        >
          {t('testing.volunteer')}
        </Cell>
      )}
      {error && <Cell multiline>{error}</Cell>}
    </Section>
  );
}
