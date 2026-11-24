import { eq } from 'drizzle-orm';
import type { Lang, Testing, TestingNext } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { shops } from '../db/schema.js';
import { tr, type BotMessageKey } from '../i18n/messages.js';
import { listTestings } from './testing.js';
import { withNext } from './testingNext.js';
import { notifyShopTeam } from './webNotices.js';

/** The organisers' next step, in words (only the steps that need them). */
function stepText(lang: Lang, next: TestingNext): string {
  const keys: Partial<Record<NonNullable<TestingNext['step']>, BotMessageKey>> = {
    unpaid: 'testing.digest.unpaid',
    extra: 'testing.digest.extra',
    draw: 'testing.digest.draw',
    vials: 'testing.digest.vials',
    report: 'testing.digest.report',
    settle: 'testing.digest.settle',
  };
  const key = next.step ? keys[next.step] : undefined;
  return key ? tr(lang, key, { n: next.unpaid, date: next.until ?? '—' }) : '';
}

/** "Sencha: ready to launch the draw" for each testing that needs the organisers. */
export function digestLines(lang: Lang, list: readonly Testing[]): string[] {
  return list
    .filter((x) => x.next?.action && x.status !== 'settled' && x.status !== 'cancelled')
    .map((x) => {
      const what = x.variantLabel ? `${x.productTitle} · ${x.variantLabel}` : x.productTitle;
      return `• ${what}: ${stepText(lang, x.next as TestingNext)}`;
    });
}

/** Once a day: each GB's team hears what its testings need from them (nothing when nothing does). */
export async function sendTestingDigests(db: Database, env: Env): Promise<number> {
  const rows = await db.select().from(shops).where(eq(shops.testingEnabled, true));
  let sent = 0;
  for (const shop of rows) {
    const list = await withNext(db, shop, await listTestings(db, shop.id));
    if (digestLines('en', list).length === 0) continue;
    await notifyShopTeam(db, env, shop, (lang) =>
      [tr(lang, 'testing.digest.title', { shop: shop.name }), ...digestLines(lang, list), '', tr(lang, 'testing.digest.footer')].join(
        '\n',
      ),
    );
    sent++;
  }
  return sent;
}

/** The day and hour in Madrid (the organisers' time), as "2026-11-21" and 9. */
export function madridNow(now: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** Every morning at 9 (Madrid), checked every 10 minutes. */
export function scheduleTestingDigests(db: Database, env: Env): void {
  let lastDay: string | null = null;
  const run = (): void => {
    const { day, hour } = madridNow(new Date());
    if (hour !== 9 || day === lastDay) return;
    lastDay = day;
    sendTestingDigests(db, env).catch((error: unknown) => console.error('Testing digest failed:', error));
  };
  setInterval(run, 10 * 60 * 1000).unref();
}
