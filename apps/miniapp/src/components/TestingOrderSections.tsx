import { useState } from 'react';
import { Button, Cell, Section, Switch } from '@telegram-apps/telegram-ui';
import type { Order, Testing } from '@tma-shop/shared';
import { api, ApiClientError } from '../api/client.js';
import { Input } from './Field.js';
import { useAsync } from '../hooks/useAsync.js';
import { formatDateTime, formatPrice } from '../lib/format.js';
import { t, tn } from '../i18n/index.js';

/**
 * What a person does in a testing through the order they take part with:
 * giving, the extra round, offering a vial. Shown on the testing screen, one
 * testing at a time (`only`), with the testings already loaded (`testings`).
 */
interface SectionProps {
  order: Order;
  /** Just this testing. */
  only?: string;
  /** The testings, when already loaded. */
  testings?: Testing[];
}

/** Their vial is sent by them: from outside, or the package already left. */
export const sendsOwn = (order: Order): boolean =>
  order.external || order.status === 'shipped' || order.status === 'fulfilled';

/**
 * Once the GB is closed, for a while: giving to the testings of what this
 * order has (whole units, added to the order and paid the usual way).
 */
export function DonationSection({
  order,
  onChanged,
  only,
  testings: given,
}: SectionProps & { onChanged: () => void }): React.JSX.Element | null {
  const testings = useAsync(() => (given ? Promise.resolve(given) : api.getTestings()), [given, order.id, order.total]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = (testings.data ?? []).filter(
    (x) =>
      (!only || x.id === only) &&
      x.donationsOpen &&
      (x.joined || x.exempt) &&
      x.currency === order.currency &&
      // From outside: the order is for that testing, with no product.
      (order.externalTestingId === x.id ||
        order.items.some(
          (item) => item.productId === x.productId && (x.variantId === null || item.variantId === x.variantId),
        )),
  );
  if (open.length === 0) return null;
  // A payment being checked: nothing can be added until it is done.
  const canGive = order.amountSubmitted === 0 && order.status !== 'cancelled' && order.status !== 'awaiting_payment';

  const run = (id: string, action: () => Promise<unknown>): void => {
    setBusy(id);
    setError(null);
    void action()
      .then(() => {
        setAmounts((current) => ({ ...current, [id]: '' }));
        onChanged();
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : t('error.title')))
      .finally(() => setBusy(null));
  };

  return (
    <Section header={t('donation.title')} footer={t('donation.footer')}>
      {open.map((x) => {
        const given = order.items
          .filter((item) => item.productId === x.donationProductId)
          .reduce((sum, item) => sum + item.subtotal, 0);
        const line = given > 0 ? given : null;
        const next = x.tiers.find((tier) => !tier.reached);
        const text = amounts[x.id] ?? '';
        const whole = /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0;
        const valid = whole >= 1 && whole <= 999;
        const name = x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle;
        return (
          <div key={x.id} className="gb-donation">
            <Cell
              multiline
              subtitle={[
                next
                  ? next.unitsLeft !== null
                    ? t('donation.next', {
                        tier: next.name,
                        units: tn(next.unitsLeft, 'testing.units.one', 'testing.units.other'),
                      })
                    : t('donation.nextShare', { tier: next.name, percent: Math.floor(next.share * 100) })
                  : t('testing.allTiers'),
                x.donationsUntil
                  ? t('donation.until', { date: formatDateTime(x.donationsUntil) })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              after={line ? formatPrice(line, order.currency) : undefined}
            >
              {name}
            </Cell>
            {canGive && (
              <div className="gb-donation-row">
                <div style={{ flex: 1 }}>
                  <Input
                    header={t('donation.amount', { currency: order.currency })}
                    type="text"
                    inputMode="numeric"
                    placeholder="10"
                    value={text}
                    status={text.trim() === '' || valid ? 'default' : 'error'}
                    onChange={(e) => setAmounts((current) => ({ ...current, [x.id]: e.target.value }))}
                  />
                </div>
                <Button
                  size="m"
                  disabled={!valid}
                  loading={busy === x.id}
                  onClick={() => run(x.id, () => api.addDonation(order.id, x.id, whole * 100))}
                >
                  {line ? t('donation.giveMore') : t('donation.give')}
                </Button>
              </div>
            )}
            {order.donationDue > 0 && order.amountSubmitted === 0 && (
              <div className="gb-donation-row">
                <Button
                  size="s"
                  mode="plain"
                  loading={busy === `remove-${x.id}`}
                  onClick={() => run(`remove-${x.id}`, () => api.removeDonation(order.id, x.id))}
                >
                  {t('donation.remove')}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {error && <Cell multiline>{error}</Cell>}
    </Section>
  );
}

/**
 * The extra round of the testings of what this order has: signing up with a
 * cap while it is open, then the share to pay, then how it went.
 */
export function ExtraSection({
  order,
  onChanged,
  only,
  testings: given,
}: SectionProps & { onChanged: () => void }): React.JSX.Element | null {
  const testings = useAsync(() => (given ? Promise.resolve(given) : api.getTestings()), [given, order.id, order.total]);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = (testings.data ?? []).filter(
    (x) =>
      (!only || x.id === only) &&
      x.extra &&
      x.joined &&
      !x.exempt &&
      (order.externalTestingId === x.id ||
        order.items.some(
          (item) => item.productId === x.productId && (x.variantId === null || item.variantId === x.variantId),
        )) &&
      (x.extra.stage === 'signup' || x.extra.mine),
  );
  if (list.length === 0) return null;
  const fmt = (amount: number): string => formatPrice(amount, order.currency);

  const run = (id: string, action: () => Promise<unknown>): void => {
    setBusy(id);
    setError(null);
    void action()
      .then(onChanged)
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : t('error.title')))
      .finally(() => setBusy(null));
  };

  return (
    <Section header={t('extra.title')} footer={t('extra.footer')}>
      {list.map((x) => {
        const extra = x.extra;
        if (!extra) return null;
        const mine = extra.mine && extra.mine.orderId === order.id ? extra.mine : null;
        const name = x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle;
        const text = caps[x.id] ?? (mine ? (mine.cap / 100).toFixed(2) : '');
        const typed = /^\d+([.,]\d{1,2})?$/.test(text.trim()) ? Math.round(Number(text.trim().replace(',', '.')) * 100) : 0;
        const quick = [extra.min, extra.min * 2, extra.min * 5];
        return (
          <div key={x.id} className="gb-donation">
            <Cell
              multiline
              subtitle={
                extra.stage === 'done'
                  ? undefined
                  : t('extra.until', { date: formatDateTime(extra.until) })
              }
            >
              {name}
            </Cell>
            {extra.stage === 'signup' && (
              <>
                {extra.missing.map((m) => (
                  <Cell key={m.id} after={<span className="gb-testing-money">{fmt(m.amount)}</span>}>
                    {t('extra.missing', { tier: m.name })}
                  </Cell>
                ))}
                <Cell multiline>
                  {extra.estimate.share !== null
                    ? t('extra.estimate', {
                        count: extra.signed,
                        tiers: extra.estimate.tiers.join(', '),
                        amount: fmt(extra.estimate.share),
                      })
                    : t('extra.estimateNone', { count: extra.signed })}
                </Cell>
                {mine && extra.estimate.out && (
                  <Cell multiline style={{ color: 'var(--tgui--destructive_text_color, #e53935)' }}>
                    {t('extra.wouldBeOut', { amount: extra.estimate.share !== null ? fmt(extra.estimate.share) : '—' })}
                  </Cell>
                )}
                <div className="gb-chips" style={{ padding: '4px 16px' }}>
                  {quick.map((amount) => (
                    <Button
                      key={amount}
                      size="s"
                      mode={typed === amount ? 'filled' : 'bezeled'}
                      onClick={() => setCaps((c) => ({ ...c, [x.id]: (amount / 100).toFixed(2) }))}
                    >
                      {fmt(amount)}
                    </Button>
                  ))}
                </div>
                <div className="gb-donation-row">
                  <div style={{ flex: 1 }}>
                    <Input
                      header={t('extra.cap', { min: fmt(extra.min) })}
                      type="text"
                      inputMode="decimal"
                      value={text}
                      status={text.trim() === '' || typed >= extra.min ? 'default' : 'error'}
                      onChange={(e) => setCaps((c) => ({ ...c, [x.id]: e.target.value }))}
                    />
                  </div>
                  <Button
                    size="m"
                    disabled={typed < extra.min}
                    loading={busy === x.id}
                    onClick={() => run(x.id, () => api.signUpExtra(order.id, x.id, typed))}
                  >
                    {mine ? t('extra.change') : t('extra.signUp')}
                  </Button>
                </div>
                {mine && (
                  <div className="gb-donation-row">
                    <Button
                      size="s"
                      mode="plain"
                      loading={busy === `leave-${x.id}`}
                      onClick={() => run(`leave-${x.id}`, () => api.leaveExtra(order.id, x.id))}
                    >
                      {t('extra.leave')}
                    </Button>
                  </div>
                )}
              </>
            )}
            {extra.stage === 'pay' && mine && (
              <Cell multiline>
                {mine.state === 'in'
                  ? t('extra.toPay', { amount: fmt(mine.share), tiers: extra.estimate.tiers.join(', ') })
                  : t('extra.out')}
              </Cell>
            )}
            {extra.stage === 'round' && mine && extra.round && (
              <>
                <Cell multiline>{t('extra.roundAsk', { gap: fmt(extra.round.gap) })}</Cell>
                {extra.round.options.map((o) => (
                  <Cell key={o.count} after={<span className="gb-testing-money">+{fmt(o.amount)}</span>}>
                    {t('extra.roundOption', { count: o.count })}
                  </Cell>
                ))}
                <div className="gb-donation-row">
                  <Button
                    size="m"
                    stretched
                    mode={mine.state === 'stay' ? 'filled' : 'bezeled'}
                    loading={busy === `stay-${x.id}`}
                    onClick={() => run(`stay-${x.id}`, () => api.answerExtraRound(order.id, x.id, true))}
                  >
                    {t('extra.stay')}
                  </Button>
                  <Button
                    size="m"
                    stretched
                    mode={mine.state === 'left' ? 'filled' : 'bezeled'}
                    loading={busy === `left-${x.id}`}
                    onClick={() => run(`left-${x.id}`, () => api.answerExtraRound(order.id, x.id, false))}
                  >
                    {t('extra.goDown')}
                  </Button>
                </div>
                <Cell multiline subtitle={t('extra.roundHint')}>
                  {mine.state === 'stay'
                    ? t('extra.roundStaying')
                    : mine.state === 'left'
                      ? t('extra.roundLeaving')
                      : t('extra.roundPending')}
                </Cell>
              </>
            )}
            {extra.stage === 'topup' && mine && (
              <Cell multiline>
                {mine.state === 'topup'
                  ? t('extra.topup')
                  : mine.state === 'left'
                    ? t('extra.left')
                    : t('extra.topupWait')}
              </Cell>
            )}
            {extra.stage === 'done' && mine && (
              <Cell multiline>
                {mine.state === 'paid' && (extra.outcome?.tiers.length ?? 0) > 0
                  ? t('extra.doneIn')
                  : mine.state === 'out'
                    ? t('extra.out')
                    : mine.state === 'left'
                      ? t('extra.left')
                      : t('extra.doneNone')}
              </Cell>
            )}
          </div>
        );
      })}
      {error && <Cell multiline>{error}</Cell>}
    </Section>
  );
}

/**
 * Offering a vial, per testing this order takes part in, until its draw:
 * each testing has its own draw with its own volunteers.
 */
export function VolunteerSection({
  order,
  only,
  testings: given,
  inCard = false,
}: SectionProps & {
  /** Inside the testing's own card: just its switch, no section of its own. */
  inCard?: boolean;
}): React.JSX.Element | null {
  const [reloadKey, setReloadKey] = useState(0);
  const testings = useAsync(() => (given ? Promise.resolve(given) : api.getTestings()), [given, order.id, order.testing, reloadKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = (testings.data ?? []).filter(
    (x) =>
      (!only || x.id === only) &&
      x.joined &&
      x.draw === null &&
      (x.status === 'open' || x.status === 'closed') &&
      (order.externalTestingId === x.id ||
        order.items.some(
          (item) => item.productId === x.productId && (x.variantId === null || item.variantId === x.variantId),
        )),
  );
  if (mine.length === 0 || order.status === 'cancelled') return null;

  const change = (testingId: string, volunteer: boolean): void => {
    setBusy(testingId);
    setError(null);
    void api
      .setTestingVolunteer(order.id, testingId, volunteer)
      .then(() => setReloadKey((k) => k + 1))
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : t('error.title')))
      .finally(() => setBusy(null));
  };

  const cells = (
    <>
      {mine.map((x) => (
        <Cell
          key={x.id}
          Component="label"
          multiline
          subtitle={sendsOwn(order) ? t('testing.externalVolunteerHint') : t('testing.volunteerHint')}
          after={
            <Switch
              checked={x.volunteer}
              disabled={busy === x.id}
              onChange={(e) => change(x.id, e.target.checked)}
            />
          }
        >
          {/* Inside a testing's own card it is clear which one: the switch's own words. */}
          {inCard ? t('testing.volunteer') : x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle}
        </Cell>
      ))}
      {error && <Cell multiline>{error}</Cell>}
    </>
  );
  if (inCard) return cells;
  return (
    <Section header={t('testing.volunteerTitle')} footer={t('testing.volunteerFooter')}>
      {cells}
    </Section>
  );
}
