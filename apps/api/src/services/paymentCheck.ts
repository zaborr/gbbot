import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  RATE_SCALE,
  TOKEN_DECIMALS,
  convertAmount,
  convertBack,
  exchangeRateFor,
  paymentMethodsOf,
  type ExchangeRates,
  type Lang,
  type Order,
  type PaymentCheck,
  type PaymentMethod,
} from '@tma-shop/shared';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { orders, shops } from '../db/schema.js';
import { checkEvmTransfer } from '../chain/evm.js';
import { checkSolanaTransfer } from '../chain/solana.js';
import type { Fetch, TxCheck } from '../chain/types.js';
import { ApiError } from '../lib/errors.js';
import { tr } from '../i18n/messages.js';
import { describeCustomer } from './customers.js';
import { getOrder, markOrderPaid } from './orders.js';
import {
  amountLine,
  buildPaymentReviewMessage,
  buildStatusMessage,
  notifyUsers,
} from './notifications.js';
import { notifyShopTeam } from './webNotices.js';
import { announceGoalMilestones } from './goal.js';

/** Orders store minor units (cents); USDC/EURC have 6 decimals on-chain. */
const RAW_PER_CENT = 10n ** BigInt(TOKEN_DECIMALS - 2);

/** Waits between tries while a transaction is not found or not confirmed (~20 min). */
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

/** Blocks on top of the transaction before trusting it. */
const MIN_CONFIRMATIONS: Record<'base' | 'ethereum', number> = { base: 3, ethereum: 3 };

export type CheckOutcome =
  | { status: 'verified'; received: number; receivedInToken?: number }
  | { status: 'failed'; reason: string; vars?: Record<string, string | number> };

/**
 * The rules for confirming a payment by itself, once the chain answered:
 * the transaction succeeded, sends the token to the shop, is not older than
 * the order, covers what is due, and no other open order waits for the same
 * amount (otherwise someone could claim a stranger's payment).
 */
export function decide(
  check: Exclude<TxCheck, { state: 'pending' }>,
  order: {
    createdAt: Date;
    total: number;
    amountPaid: number;
    currency: string;
    /** Paid in the other token at this rate: amounts are compared in that token. */
    paymentExchange?: { token: string; rate: number } | null;
  },
  competingOrders: number,
  /** Formats an amount of the token paid. */
  money: (cents: number) => string,
): CheckOutcome {
  if (check.state === 'failed') return { status: 'failed', reason: 'tx_failed' };
  const received = Number(check.amount / RAW_PER_CENT);
  if (received <= 0) return { status: 'failed', reason: 'no_transfer' };
  const exchange = order.paymentExchange ?? null;
  // A little slack for clock differences between the chain and the server.
  if (check.timestamp * 1000 < order.createdAt.getTime() - 60_000) {
    return { status: 'failed', reason: 'too_old' };
  }
  const due = order.total - order.amountPaid;
  const expected = exchange ? convertAmount(due, exchange.rate) : due;
  if (received < expected) {
    return { status: 'failed', reason: 'short', vars: { received: money(received), expected: money(expected) } };
  }
  if (competingOrders > 0) {
    return { status: 'failed', reason: 'ambiguous', vars: { count: competingOrders + 1 } };
  }
  return exchange
    ? { status: 'verified', received: convertBack(received, exchange.rate), receivedInToken: received }
    : { status: 'verified', received };
}

/** Asks the right chain about a transaction. */
export async function checkOnChain(
  env: Env,
  method: PaymentMethod,
  txHash: string,
  fetchImpl: Fetch = fetch,
): Promise<TxCheck> {
  switch (method.chain) {
    case 'base':
      return checkEvmTransfer(env.RPC_BASE_URL, txHash, method.contract, method.address, MIN_CONFIRMATIONS.base, fetchImpl);
    case 'ethereum':
      return checkEvmTransfer(
        env.RPC_ETHEREUM_URL,
        txHash,
        method.contract,
        method.address,
        MIN_CONFIRMATIONS.ethereum,
        fetchImpl,
      );
    case 'solana':
      return checkSolanaTransfer(env.RPC_SOLANA_URL, txHash, method.contract, method.address, fetchImpl);
  }
}

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/** Text of a failed check, for the bot. */
export function reasonText(lang: Lang, check: PaymentCheck, network: string): string {
  const vars = { network, ...(check.vars ?? {}) };
  switch (check.reason) {
    case 'not_found':
      return tr(lang, 'check.not_found', vars);
    case 'tx_failed':
      return tr(lang, 'check.tx_failed', vars);
    case 'no_transfer':
      return tr(lang, 'check.no_transfer', vars);
    case 'too_old':
      return tr(lang, 'check.too_old', vars);
    case 'short':
      return tr(lang, 'check.short', vars);
    case 'ambiguous':
      return tr(lang, 'check.ambiguous', vars);
    case 'stock_short':
      return tr(lang, 'check.stock_short', vars);
    case 'no_method':
      return tr(lang, 'check.no_method', vars);
    default:
      return tr(lang, 'check.rpc_error', vars);
  }
}

async function saveCheck(db: Database, orderId: string, check: PaymentCheck): Promise<void> {
  await db.update(orders).set({ paymentCheck: check }).where(eq(orders.id, orderId));
}

/** Other open orders of the shop waiting for exactly this amount, made before the transaction. */
async function competingOrders(
  db: Database,
  row: typeof orders.$inferSelect,
  txHash: string,
  txTime: Date,
  rates: ExchangeRates | undefined,
): Promise<number> {
  // The amount the transaction carries, in the token paid…
  const token = row.paymentExchange?.token ?? row.currency;
  const amount = row.paymentExchange
    ? convertAmount(row.total - row.amountPaid, row.paymentExchange.rate)
    : row.total - row.amountPaid;
  // …matched against orders in that token, or in the other one at the shop's rate.
  const other = token === 'USDC' ? 'EURC' : 'USDC';
  const rate = exchangeRateFor(rates, other, token);
  const sameAmount = or(
    and(eq(orders.currency, token), sql`${orders.total} - ${orders.amountPaid} = ${amount}`),
    rate === null
      ? undefined
      : and(
          eq(orders.currency, other),
          sql`ceil((${orders.total} - ${orders.amountPaid}) * ${rate}::numeric / ${RATE_SCALE}) = ${amount}`,
        ),
  );
  const others = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.shopId, row.shopId),
        ne(orders.id, row.id),
        inArray(orders.status, ['pending', 'awaiting_payment']),
        sameAmount,
        lte(orders.createdAt, txTime),
        // An order already claiming another transaction is not a candidate.
        or(isNull(orders.paymentTxHash), eq(orders.paymentTxHash, txHash)),
      ),
    );
  return others.length;
}

const running = new Set<string>();

/**
 * Checks the order's current transaction on its blockchain and, if every rule
 * passes, confirms the payment. Otherwise the order stays for manual review
 * with the reason. Retries for a while when the transaction is not confirmed.
 */
export async function runPaymentCheck(
  db: Database,
  env: Env,
  orderId: string,
  attempt = 0,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const row = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  const txHash = row?.paymentTxHash;
  if (!row || !txHash || row.status !== 'awaiting_payment' || row.paymentCheck?.status !== 'checking') {
    // Decided meanwhile (by an admin, or a new transaction): stop this check.
    for (const key of running) if (key.startsWith(`${orderId}:`)) running.delete(key);
    return;
  }
  const key = `${orderId}:${txHash}`;
  if (attempt === 0 && running.has(key)) return;
  running.add(key);

  const shop = await db.query.shops.findFirst({ where: eq(shops.id, row.shopId) });
  const method = paymentMethodsOf(shop?.paymentSetup).find((m) => m.id === row.paymentMethodId);
  const now = (): string => new Date().toISOString();

  const finish = async (outcome: CheckOutcome): Promise<void> => {
    running.delete(key);
    if (!shop) return;
    if (outcome.status === 'verified') {
      try {
        await markOrderPaid(db, orderId, txHash, {
          checkStock: true,
          received: outcome.received,
          ...(outcome.receivedInToken === undefined ? {} : { receivedInToken: outcome.receivedInToken }),
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'stock_short') {
          await finish({ status: 'failed', reason: 'stock_short' });
          return;
        }
        throw error;
      }
      await saveCheck(db, orderId, { status: 'verified', reason: null, vars: null, at: now() });
      await announceGoalMilestones(db, env, row.shopId);
      const order = await getOrder(db, row.shopId, orderId);
      if (!order) return;
      const customer = order.userId === null ? '—' : await describeCustomer(db, order.userId);
      await notifyShopTeam(db, env, shop, (lang) => autoConfirmedMessage(lang, order, customer));
      if (order.userId !== null) {
        await notifyUsers(db, env.BOT_TOKEN, [order.userId], (lang) =>
          buildStatusMessage(lang, shop.name, order, 'awaiting_payment'),
        );
      }
      return;
    }
    const check: PaymentCheck = {
      status: 'failed',
      reason: outcome.reason,
      vars: outcome.vars ?? null,
      at: now(),
    };
    await saveCheck(db, orderId, check);
    const order = await getOrder(db, row.shopId, orderId);
    if (!order) return;
    const customer = order.userId === null ? '—' : await describeCustomer(db, order.userId);
    const network = method?.network ?? row.paymentNetwork ?? '—';
    await notifyShopTeam(db, env, shop, (lang) =>
      [
        buildPaymentReviewMessage(lang, order, customer),
        '',
        tr(lang, 'check.failedHeader', { reason: reasonText(lang, check, network) }),
      ].join('\n'),
    );
  };

  if (!method) {
    await finish({ status: 'failed', reason: 'no_method' });
    return;
  }

  let result: TxCheck;
  try {
    result = await checkOnChain(env, method, txHash, fetchImpl);
  } catch (error) {
    console.error(`Payment check of order ${orderId} failed (try ${attempt + 1}):`, error);
    result = { state: 'pending' };
    if (attempt >= RETRY_DELAYS_MS.length) {
      await finish({ status: 'failed', reason: 'rpc_error' });
      return;
    }
  }

  if (result.state === 'pending') {
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      await finish({ status: 'failed', reason: 'not_found' });
      return;
    }
    setTimeout(() => {
      runPaymentCheck(db, env, orderId, attempt + 1, fetchImpl).catch((error: unknown) =>
        console.error(`Payment check of order ${orderId} crashed:`, error),
      );
    }, delay).unref();
    return;
  }

  const txTime = result.state === 'ok' ? new Date(result.timestamp * 1000) : new Date();
  const competitors = result.state === 'ok' ? await competingOrders(db, row, txHash, txTime, shop?.paymentSetup?.exchange) : 0;
  await finish(
    decide(result, row, competitors, (cents) => money(cents, row.paymentExchange?.token ?? row.currency)),
  );
}

/** Starts the check in the background (the customer does not wait for it). */
export function startPaymentCheck(db: Database, env: Env, orderId: string): void {
  runPaymentCheck(db, env, orderId).catch((error: unknown) =>
    console.error(`Payment check of order ${orderId} crashed:`, error),
  );
}

/** After a restart, picks up the checks that were still running. */
export async function resumePaymentChecks(db: Database, env: Env): Promise<void> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(eq(orders.status, 'awaiting_payment'), sql`${orders.paymentCheck}->>'status' = 'checking'`),
    );
  for (const row of rows) startPaymentCheck(db, env, row.id);
}

/** Admin message for a payment the app confirmed by itself. */
function autoConfirmedMessage(lang: Lang, order: Order, customer: string): string {
  const last = order.paymentLog[order.paymentLog.length - 1];
  const paid = last?.amount ?? order.amountPaid;
  const lines = [
    tr(lang, 'check.autoConfirmed'),
    '',
    tr(lang, 'order.number', { id: order.id.slice(0, 8) }),
    tr(lang, 'line.customer', { customer }),
    amountLine(lang, paid, order.currency, last?.paid ?? null),
    tr(lang, 'line.method', { method: order.paymentNetwork ?? '—' }),
    tr(lang, 'line.tx', { tx: order.paymentTxHash ?? '—' }),
  ];
  if (order.paymentTxUrl) lines.push('', order.paymentTxUrl);
  if (order.amountDue < 0) {
    lines.push('', tr(lang, 'check.overpaid', { amount: money(-order.amountDue, order.currency) }));
  }
  return lines.join('\n');
}
