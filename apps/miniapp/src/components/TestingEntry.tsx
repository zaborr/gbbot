import { Cell, Section } from '@telegram-apps/telegram-ui';
import type { Order, Testing } from '@tma-shop/shared';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { testingLive } from '../lib/testingState.js';
import { t } from '../i18n/index.js';

/** Bought here (an order with the tested product), so they join with that order. */
const boughtHere = (x: Testing, orders: readonly Order[]): boolean =>
  orders.some(
    (o) =>
      o.status !== 'cancelled' &&
      o.items.some((i) => i.productId === x.productId && (x.variantId === null || i.variantId === x.variantId)),
  );

/**
 * The way to the testing screen (catalog, orders): how many testings one is
 * in and how many one can really join (bought it here, or open to people from
 * outside) — the same ones the screen offers. Nothing when there is none.
 */
export function TestingEntry({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const testings = useAsync(() => api.getTestings(), []);
  const orders = useAsync(() => api.getOrders(), []);
  const all = testings.data ?? [];
  const mine = orders.data ?? [];
  const inNow = all.filter((x) => x.joined && x.status !== 'settled' && x.status !== 'cancelled').length;
  const canJoin = all.filter(
    (x) => !x.joined && !x.exempt && testingLive(x) && (boughtHere(x, mine) || x.externalOpen),
  ).length;
  if (inNow === 0 && canJoin === 0) return null;
  const parts = [
    inNow > 0 ? t('testingHub.entryIn', { count: inNow }) : null,
    canJoin > 0 ? t('testingHub.entryCan', { count: canJoin }) : null,
  ].filter(Boolean);
  return (
    <Section>
      <Cell multiline onClick={onOpen} after="›" subtitle={parts.join(' · ')}>
        {t('testingHub.entry')}
      </Cell>
    </Section>
  );
}
