import { useState } from 'react';
import { Button, Cell, Section, Switch } from '@telegram-apps/telegram-ui';
import type { Order, Testing } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { formatPrice, formatDateTime } from '../lib/format.js';
import { sharePercent, testingLive as joinable, testingState } from '../lib/testingState.js';
import { useSession } from '../providers/SessionProvider.js';
import { TestingBar } from './TestingCard.js';
import { t } from '../i18n/index.js';

type Action =
  | { kind: 'order'; orderId: string }
  | { kind: 'see'; orderId: string }
  | { kind: 'outside' };

/**
 * The testings one can still join, on the testing screen: how far each is
 * and how to join (with the order they bought it in, or from outside), with
 * a vial offered or not for each one's draw.
 */
export function TestingsInProgress({
  orders,
  testings: given,
  onOrder,
  onJoined,
  onChanged,
}: {
  orders: readonly Order[];
  /** The testings, when already loaded (the testing screen). */
  testings?: Testing[];
  /** To an order (one that cannot join yet, e.g. a payment being checked). */
  onOrder: (orderId: string) => void;
  /** Joined: names the testing, to say so. */
  onJoined: (name: string) => void;
  onChanged: () => void;
}): React.JSX.Element | null {
  const testings = useAsync(() => (given ? Promise.resolve(given) : api.getTestings()), [given]);
  const { user } = useSession();
  // Each testing has its own draw: offering a vial is per testing.
  const [volunteer, setVolunteer] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Shown under the testing it is about, next to its button.
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  const withProduct = (x: Testing): Order[] =>
    orders.filter(
      (o) =>
        o.status !== 'cancelled' &&
        o.items.some((i) => i.productId === x.productId && (x.variantId === null || i.variantId === x.variantId)),
    );
  const actionOf = (x: Testing): Action | null => {
    if (!joinable(x) || x.exempt) return null;
    const mine = withProduct(x);
    if (mine.length > 0) {
      // Not while a payment is being checked; sent ones once the GB closed.
      const fits = mine.find(
        (o) =>
          o.currency === x.currency &&
          (o.status === 'paid' ||
            (o.status === 'pending' && o.amountSubmitted === 0) ||
            (x.status === 'closed' && (o.status === 'shipped' || o.status === 'fulfilled'))),
      );
      return fits ? { kind: 'order', orderId: fits.id } : { kind: 'see', orderId: mine[0]!.id };
    }
    return x.externalOpen ? { kind: 'outside' } : null;
  };

  const rows = (testings.data ?? [])
    .filter((x) => !x.joined && joinable(x))
    .map((x) => ({ x, action: actionOf(x) }))
    .filter((r): r is { x: Testing; action: Action } => r.action !== null);
  if (rows.length === 0) return null;
  const nameOf = (x: Testing): string => (x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle);

  const run = (x: Testing, act: () => Promise<string>): void => {
    setBusy(x.id);
    setError(null);
    void act()
      .then(() => {
        onChanged();
        onJoined(nameOf(x));
      })
      .catch((err: unknown) =>
        setError({ id: x.id, message: err instanceof ApiClientError ? err.message : t('error.title') }),
      )
      .finally(() => setBusy(null));
  };

  const fee = (x: Testing): string =>
    x.contribution > 0
      ? t('testing.participate', { amount: formatPrice(x.contribution, x.currency) })
      : t('testing.participateFree');

  const button = (x: Testing, action: Action): React.JSX.Element => {
    switch (action.kind) {
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
              run(x, () =>
                api.addOrderTesting(action.orderId, x.id, volunteer[x.id] ?? false).then(() => action.orderId),
              )
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
              run(x, () =>
                api.joinExternalTesting(x.id, volunteer[x.id] ?? false, user?.username ?? null).then((r) => r.orderId),
              )
            }
          >
            {fee(x)}
          </Button>
        );
    }
  };

  const outside = rows.some((r) => r.action.kind === 'outside');
  // One card per testing: its button, its bar and its own vial offer stay together.
  return (
    <>
      {rows.map(({ x, action }, index) => {
        const { next } = testingState(x);
        const until =
          x.status === 'closed' && x.donationsUntil
            ? t('testing.joinUntil', { date: formatDateTime(x.donationsUntil) })
            : null;
        return (
          <Section
            key={x.id}
            header={t('testing.canJoinCard', { product: nameOf(x) })}
            footer={outside && index === rows.length - 1 ? t('testing.externalFooter') : undefined}
          >
            <Cell
              multiline
              subtitle={[
                next ? t('testing.shareCovered', { percent: sharePercent(next) }) : t('testing.allTiers'),
                until,
              ]
                .filter(Boolean)
                .join(' · ')}
              after={button(x, action)}
            >
              {x.lab}
            </Cell>
            {error?.id === x.id && (
              <Cell multiline>
                <span style={{ color: 'var(--tgui--destructive_text_color)' }}>{error.message}</span>
              </Cell>
            )}
            <div style={{ padding: '0 16px 12px' }}>
              <TestingBar testing={x} />
            </div>
            {(action.kind === 'order' || action.kind === 'outside') && (
              <Cell
                Component="label"
                after={
                  <Switch
                    checked={volunteer[x.id] ?? false}
                    onChange={(e) => setVolunteer((current) => ({ ...current, [x.id]: e.target.checked }))}
                  />
                }
                subtitle={
                  // No package to take it from: from outside, or the order was already sent.
                  action.kind === 'outside' ||
                  ['shipped', 'fulfilled'].includes(orders.find((o) => o.id === action.orderId)?.status ?? '')
                    ? t('testing.externalVolunteerHint')
                    : t('testing.volunteerHint')
                }
                multiline
              >
                {t('testing.volunteer')}
              </Cell>
            )}
          </Section>
        );
      })}
    </>
  );
}
