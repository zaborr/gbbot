import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { TestingReportView } from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orders, shops, testingEntries, testingExtraMembers, testingReports, testings } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { TelegramApi } from '../telegram/api.js';
import { botToken } from './activeBot.js';
import { describeUser } from './team.js';
import { testedLabel } from './testingDraw.js';

type ReportRow = typeof testingReports.$inferSelect;
type TestingRow = typeof testings.$inferSelect;

/** Copies kept up to this size (Telegram lets bots download up to 20 MB). */
const MAX_BYTES = 20 * 1024 * 1024;
/** Could not be downloaded (another bot's file, too big): not tried again. */
const NO_COPY = -1;

/**
 * A report just sent: kept with a copy of the file, so it can be looked up
 * later whatever happens to Telegram or to the bot in use.
 */
export async function saveReport(
  db: Database,
  telegram: TelegramApi,
  testing: TestingRow,
  input: {
    kind: 'base' | 'extra';
    fileKind: 'document' | 'photo';
    fileId: string;
    fileName?: string | null;
    mime?: string | null;
    uploadedBy: number;
    delivered: number;
  },
): Promise<void> {
  const data = await telegram.downloadFile(input.fileId).catch((error: unknown) => {
    console.error('Report copy failed:', error);
    return null;
  });
  const kept = data && data.length <= MAX_BYTES ? data : null;
  await db.insert(testingReports).values({
    testingId: testing.id,
    shopId: testing.shopId,
    kind: input.kind,
    fileKind: input.fileKind,
    fileId: input.fileId,
    fileName: input.fileName ?? null,
    mime: input.mime ?? (input.fileKind === 'photo' ? 'image/jpeg' : null),
    data: kept,
    size: kept ? kept.length : NO_COPY,
    uploadedBy: input.uploadedBy,
    delivered: input.delivered,
  });
}

/** Reports kept before copies existed: their files are fetched, a few at a time. */
export async function copyMissingReports(db: Database, env: Env): Promise<void> {
  const rows = await db
    .select({ id: testingReports.id, fileId: testingReports.fileId })
    .from(testingReports)
    .where(and(isNull(testingReports.data), isNull(testingReports.size)))
    .limit(5);
  if (rows.length === 0) return;
  const telegram = new TelegramApi(botToken(env));
  for (const row of rows) {
    const data = await telegram.downloadFile(row.fileId).catch(() => null);
    const kept = data && data.length <= MAX_BYTES ? data : null;
    await db
      .update(testingReports)
      .set({ data: kept, size: kept ? kept.length : NO_COPY })
      .where(eq(testingReports.id, row.id));
  }
}

/** The tiers a report is about: those of its round. */
function tiersOf(testing: TestingRow, kind: 'base' | 'extra'): string[] {
  const extraIds = new Set(testing.extra?.outcome?.tiers ?? []);
  const ids = kind === 'extra' ? [...extraIds] : (testing.draw?.tiersDone ?? []).filter((id) => !extraIds.has(id));
  return testing.tiers.filter((t) => ids.includes(t.id)).map((t) => t.name);
}

/** Reports, newest first: one GB's, a few GBs', or all (the platform). */
export async function listReports(
  db: Database,
  where: { shopIds?: readonly string[]; testingIds?: readonly string[] },
): Promise<TestingReportView[]> {
  if ((where.shopIds && where.shopIds.length === 0) || (where.testingIds && where.testingIds.length === 0)) return [];
  const rows = await db
    .select({ report: testingReports, testing: testings, shopName: shops.name })
    .from(testingReports)
    .innerJoin(testings, eq(testingReports.testingId, testings.id))
    .innerJoin(shops, eq(testingReports.shopId, shops.id))
    .where(
      and(
        where.shopIds ? inArray(testingReports.shopId, [...where.shopIds]) : undefined,
        where.testingIds ? inArray(testingReports.testingId, [...where.testingIds]) : undefined,
      ),
    )
    .orderBy(desc(testingReports.createdAt));
  const names = new Map<number, string>();
  const result: TestingReportView[] = [];
  for (const { report, testing, shopName } of rows) {
    if (report.uploadedBy !== null && !names.has(report.uploadedBy)) {
      names.set(report.uploadedBy, await describeUser(db, report.uploadedBy));
    }
    result.push({
      id: report.id,
      testingId: testing.id,
      shopId: report.shopId,
      shopName,
      product: await testedLabel(db, testing),
      lab: testing.lab,
      kind: report.kind,
      fileKind: report.fileKind,
      fileName: report.fileName,
      tiers: tiersOf(testing, report.kind),
      createdAt: report.createdAt.toISOString(),
      delivered: report.delivered,
      uploadedBy: report.uploadedBy !== null ? (names.get(report.uploadedBy) ?? null) : null,
      hasCopy: (report.size ?? 0) > 0,
    });
  }
  return result;
}

/** One report's row, checked to belong where it is asked from. */
export async function findReport(db: Database, id: string, shopIds?: readonly string[]): Promise<ReportRow> {
  const row = await db.query.testingReports.findFirst({ where: eq(testingReports.id, id) });
  if (!row || (shopIds && !shopIds.includes(row.shopId))) throw ApiError.notFound('Report not found');
  return row;
}

/** A report's file name, for downloading. */
export function reportFileName(row: ReportRow): string {
  if (row.fileName) return row.fileName;
  const ext = row.fileKind === 'photo' ? 'jpg' : row.mime === 'application/pdf' ? 'pdf' : 'bin';
  return `report-${row.kind}-${row.createdAt.toISOString().slice(0, 10)}.${ext}`;
}

/** Sends a report to someone through the bot (the copy, or Telegram's file). */
export async function sendReportTo(env: Env, row: ReportRow, chatId: number, caption: string): Promise<void> {
  const telegram = new TelegramApi(botToken(env));
  if (row.data) {
    if (row.fileKind === 'photo') {
      await telegram.sendFileById(chatId, 'photo', row.fileId, caption).catch(async () => {
        await telegram.sendDocument(chatId, reportFileName(row), row.data!, row.mime ?? 'image/jpeg', caption);
      });
      return;
    }
    await telegram.sendDocument(chatId, reportFileName(row), row.data, row.mime ?? 'application/octet-stream', caption);
    return;
  }
  await telegram.sendFileById(chatId, row.fileKind, row.fileId, caption);
}

/**
 * The reports one person can see again in a GB: the base one of each testing
 * they took part in, and the extra round's when they paid it (or were exempt).
 */
export async function reportsFor(
  db: Database,
  shopId: string,
  userId: number,
): Promise<TestingReportView[]> {
  const entries = await db
    .select({ testingId: testingEntries.testingId, isVip: orders.isVip, feeMode: testings.feeMode })
    .from(testingEntries)
    .innerJoin(orders, eq(testingEntries.orderId, orders.id))
    .innerJoin(testings, eq(testingEntries.testingId, testings.id))
    .where(and(eq(testings.shopId, shopId), eq(testingEntries.userId, userId), ne(orders.status, 'cancelled')));
  const paidExtra = await db
    .select({ testingId: testingExtraMembers.testingId })
    .from(testingExtraMembers)
    .where(and(eq(testingExtraMembers.userId, userId), eq(testingExtraMembers.state, 'paid')));
  const base = new Set(entries.map((e) => e.testingId));
  const extra = new Set([
    ...paidExtra.map((m) => m.testingId),
    ...entries.filter((e) => e.isVip && e.feeMode === 'mandatory_non_vip').map((e) => e.testingId),
  ]);
  const all = await listReports(db, { shopIds: [shopId], testingIds: [...new Set([...base, ...extra])] });
  return all.filter((r) => (r.kind === 'base' ? base.has(r.testingId) : extra.has(r.testingId)));
}

/** The kept copy as a response (opened in the app, or saved). */
export function reportFile(row: ReportRow): Response {
  if (!row.data) throw ApiError.notFound('This report has no copy here: have it sent through the bot');
  const name = reportFileName(row).replace(/[^\w.-]+/g, '_');
  return new Response(new Uint8Array(row.data), {
    headers: {
      'Content-Type': row.mime ?? 'application/octet-stream',
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

/** The caption a report goes with when sent again. */
export async function reportCaption(db: Database, row: ReportRow): Promise<string> {
  const testing = await db.query.testings.findFirst({ where: eq(testings.id, row.testingId) });
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, row.shopId) });
  const what = testing ? await testedLabel(db, testing) : '';
  return [shop?.name, what, testing?.lab, row.createdAt.toISOString().slice(0, 10)].filter(Boolean).join(' · ');
}
