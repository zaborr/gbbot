import { Cell, Section } from '@telegram-apps/telegram-ui';
import type { Testing } from '@tma-shop/shared';
import { formatDateTime } from '../lib/format.js';
import { useShop } from '../providers/ShopProvider.js';
import { locale, t, type MessageKey } from '../i18n/index.js';
import { TestingNextLine } from './TestingNext.js';

type Mark = 'done' | 'now' | 'later';
interface Point {
  key: string;
  label: MessageKey;
  mark: Mark;
  /** When it happened, or when it is planned. */
  date: string | null;
}

const ICON: Record<Mark, string> = { done: '✅', now: '⏳', later: '○' };

function when(value: string | null): string | null {
  if (!value) return null;
  return value.length === 10 ? new Date(`${value}T12:00:00`).toLocaleDateString(locale()) : formatDateTime(value);
}

/** The steps of a testing, from the GB closing to closing the testing, with their dates. */
function points(testing: Testing, shop: { closedAt: string | null; closesAt: string | null }, nowMs: number): Point[] {
  const past = (value: string | null): boolean => value !== null && new Date(value).getTime() <= nowMs;
  const closed = shop.closedAt !== null || past(shop.closesAt);
  const drawn = testing.status === 'drawn' || testing.status === 'settled';
  const lab = testing.labProgress ?? {};
  const list: Point[] = [];
  const add = (key: string, label: MessageKey, done: boolean, date: string | null): void => {
    list.push({ key, label, mark: done ? 'done' : 'later', date });
  };
  add('close', 'testing.timeline.gbClose', closed, shop.closedAt ?? shop.closesAt);
  if (testing.donationsUntil || testing.donationHours > 0) {
    add('window', 'testing.timeline.window', closed && !testing.donationsOpen, testing.donationsUntil);
  }
  if (testing.extraEnabled) {
    const extra = testing.extra;
    add('extra', 'testing.timeline.extra', extra?.stage === 'done' || drawn, extra?.until ?? null);
  }
  add('draw', 'testing.timeline.draw', drawn, testing.draw?.drawnAt ?? testing.draw?.announcedAt ?? null);
  add('sent', 'testing.timeline.vialsSent', Boolean(lab.sentAt), lab.sentAt ?? null);
  add('received', 'testing.timeline.vialsReceived', Boolean(lab.receivedAt), lab.receivedAt ?? null);
  add('report', 'testing.timeline.report', Boolean(testing.reportSentAt), testing.reportSentAt ?? lab.expected ?? null);
  if ((testing.extra?.outcome?.tiers.length ?? 0) > 0) {
    add('extraReport', 'testing.timeline.extraReport', Boolean(testing.extraReportSentAt), testing.extraReportSentAt);
  }
  add('settle', 'testing.timeline.settle', testing.status === 'settled', null);
  // The first not done is where it is now.
  const current = list.find((p) => p.mark !== 'done');
  if (current && testing.status !== 'cancelled') current.mark = 'now';
  return list;
}

/** What comes next, and every step of the testing with its date. */
export function TestingTimeline({ testing }: { testing: Testing }): React.JSX.Element | null {
  const { shop } = useShop();
  if (testing.status === 'cancelled') return null;
  const list = points(testing, shop, Date.now());
  return (
    <>
      {testing.next?.step && (
        <Section header={t('testing.timeline.next')}>
          <Cell multiline>
            <TestingNextLine next={testing.next} />
          </Cell>
        </Section>
      )}
      <Section header={t('testing.timeline.title')} footer={t('testing.timeline.footer')}>
        {list.map((p) => (
          <Cell
            key={p.key}
            before={<span style={{ width: 22, textAlign: 'center' }}>{ICON[p.mark]}</span>}
            after={when(p.date) ?? undefined}
            multiline
          >
            <span style={{ fontWeight: p.mark === 'now' ? 600 : 400, opacity: p.mark === 'later' ? 0.6 : 1 }}>
              {t(p.label)}
            </span>
          </Cell>
        ))}
      </Section>
    </>
  );
}
