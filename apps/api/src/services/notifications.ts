import { inArray } from 'drizzle-orm';
import { RATE_SCALE, convertAmount, userLang, type Lang, type Order, type OrderStatus } from '@tma-shop/shared';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { tr } from '../i18n/messages.js';
import { TelegramApi } from '../telegram/api.js';

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/**
 * "Amount: 30.00 EURC", or, paid in the other token,
 * "Amount: 33.00 USDC (= 30.00 EURC, 1 EURC = 1.1 USDC)".
 */
export function amountLine(
  lang: Lang,
  amount: number,
  currency: string,
  paid: { amount: number; token: string; rate: number } | null,
): string {
  if (!paid) return tr(lang, 'line.amount', { amount: money(amount, currency) });
  return tr(lang, 'line.amountExchanged', {
    paid: money(paid.amount, paid.token),
    amount: money(amount, currency),
    rate: `1 ${currency} = ${paid.rate / RATE_SCALE} ${paid.token}`,
  });
}

function shortId(order: Order): string {
  return order.id.slice(0, 8);
}

function contactLine(lang: Lang, order: Order): string {
  return tr(lang, 'line.contact', {
    contact: order.contactUsername ? `@${order.contactUsername}` : '—',
  });
}

/** Plain-text summary of an order waiting for manual payment verification. */
export function buildPaymentReviewMessage(lang: Lang, order: Order, customer: string): string {
  const amount = order.amountSubmitted > 0 ? order.amountSubmitted : order.amountDue;
  const lines = [
    tr(lang, order.amountPaid > 0 ? 'admin.differenceToVerify' : 'admin.paymentToVerify'),
    '',
    tr(lang, 'order.number', { id: shortId(order) }),
    tr(lang, 'line.customer', { customer }),
    contactLine(lang, order),
    amountLine(
      lang,
      amount,
      order.currency,
      order.paymentExchange
        ? { ...order.paymentExchange, amount: convertAmount(amount, order.paymentExchange.rate) }
        : null,
    ),
    ...(order.shippingZoneName ? [tr(lang, 'line.shipping', { zone: order.shippingZoneName })] : []),
    tr(lang, 'line.method', { method: order.paymentNetwork ?? '—' }),
    order.paymentManual
      ? tr(lang, 'line.reference', { ref: order.paymentTxHash ?? '—' })
      : tr(lang, 'line.tx', { tx: order.paymentTxHash ?? '—' }),
  ];
  if (order.paymentTxUrl) lines.push('', order.paymentTxUrl);
  if (order.paymentManual) {
    lines.push('', tr(lang, 'admin.manualToVerify', { method: order.paymentNetwork ?? '—' }));
  }
  lines.push('', tr(lang, 'admin.openToConfirm'));
  return lines.join('\n');
}

/** Tells admins a customer wants to modify a paid order. */
export function buildChangeRequestMessage(lang: Lang, order: Order, customer: string): string {
  const change = order.changeRequest;
  if (!change) return '';
  const diff = change.total - order.amountPaid;
  const lines = [
    tr(lang, 'admin.changeRequested'),
    '',
    tr(lang, 'order.number', { id: shortId(order) }),
    tr(lang, 'line.customer', { customer }),
    contactLine(lang, order),
    '',
    tr(lang, 'admin.newItems'),
    ...change.items.map(
      (item) =>
        `• ${item.quantity}× ${item.title}${item.variantLabel ? ` (${item.variantLabel})` : ''}`,
    ),
    '',
    tr(lang, 'admin.total', {
      from: money(order.total, order.currency),
      to: money(change.total, order.currency),
    }),
    diff > 0
      ? tr(lang, 'admin.customerWouldPay', { amount: money(diff, order.currency) })
      : diff < 0
        ? tr(lang, 'admin.youWouldRefund', { amount: money(-diff, order.currency) })
        : tr(lang, 'admin.sameAmount'),
    '',
    tr(lang, 'admin.openToApprove'),
  ];
  return lines.join('\n');
}

/** Tells the customer what happened to their change request. */
export function buildChangeDecisionMessage(lang: Lang, order: Order, approved: boolean): string {
  const ref = tr(lang, 'order.number', { id: shortId(order) });
  if (!approved) return tr(lang, 'change.rejected', { ref });
  const lines = [
    tr(lang, 'change.approved', { ref }),
    tr(lang, 'change.newTotal', { amount: money(order.total, order.currency) }),
  ];
  if (order.amountDue > 0) {
    lines.push(tr(lang, 'change.payDifference', { amount: money(order.amountDue, order.currency) }));
  } else if (order.amountDue < 0) {
    lines.push(tr(lang, 'refund.willRefund', { amount: money(-order.amountDue, order.currency) }));
  }
  return lines.join('\n');
}

/**
 * Tells the customer their order moved to another status, with the shop's
 * note if the admin wrote one. Empty when there is nothing to say.
 */
export function buildStatusMessage(
  lang: Lang,
  shopName: string,
  order: Order,
  previous: OrderStatus,
): string {
  const ref = tr(lang, 'order.ref', { shop: shopName, id: shortId(order) });
  const lines: string[] = [];
  switch (order.status) {
    case 'paid':
      lines.push(tr(lang, 'status.paid', { ref }));
      if (order.amountDue < 0) {
        lines.push(tr(lang, 'refund.willRefund', { amount: money(-order.amountDue, order.currency) }));
      }
      break;
    case 'pending':
      // A rejected payment clears the transaction; a partial one keeps it.
      if (previous === 'awaiting_payment' && order.paymentTxHash === null) {
        lines.push(tr(lang, 'status.rejected', { ref }), tr(lang, 'status.rejectedHint'));
      } else {
        lines.push(
          tr(lang, 'status.partial', { ref }),
          tr(lang, 'status.partialHint', { amount: money(order.amountDue, order.currency) }),
        );
      }
      break;
    case 'shipped':
      lines.push(tr(lang, 'status.shipped', { ref }));
      if (order.trackingNumber) lines.push(tr(lang, 'status.tracking', { tracking: order.trackingNumber }));
      break;
    case 'fulfilled':
      lines.push(tr(lang, 'status.delivered', { ref }));
      break;
    case 'cancelled':
      lines.push(tr(lang, 'status.cancelled', { ref }));
      if (order.amountDue < 0) {
        lines.push(tr(lang, 'refund.willRefund', { amount: money(-order.amountDue, order.currency) }));
      }
      break;
    case 'awaiting_payment':
      break;
  }
  if (lines.length === 0) return '';
  if (order.statusNote) lines.push('', tr(lang, 'status.shopMessage', { note: order.statusNote }));
  return lines.join('\n');
}

/** Each user's language, from their Telegram settings (English when unknown). */
export async function languagesOf(db: Database, telegramIds: number[]): Promise<Map<number, Lang>> {
  const result = new Map<number, Lang>();
  if (telegramIds.length === 0) return result;
  const rows = await db
    .select({
      id: users.telegramId,
      languageCode: users.languageCode,
      preferredLang: users.preferredLang,
    })
    .from(users)
    .where(inArray(users.telegramId, telegramIds));
  for (const row of rows) result.set(row.id, userLang(row.preferredLang, row.languageCode));
  return result;
}

/** Sends each user the message built in their own language (best effort). */
export async function notifyUsers(
  db: Database,
  botToken: string,
  telegramIds: number[],
  build: (lang: Lang) => string,
  telegram = new TelegramApi(botToken),
): Promise<void> {
  const langs = await languagesOf(db, telegramIds);
  await Promise.all(
    telegramIds.map((id) =>
      notifyChats(botToken, [id], build(langs.get(id) ?? 'en'), telegram),
    ),
  );
}

/**
 * Sends a message to each chat. Best effort: a failure (e.g. a user who never
 * started the bot) is logged, never thrown.
 */
export async function notifyChats(
  botToken: string,
  chatIds: number[],
  text: string,
  telegram = new TelegramApi(botToken),
): Promise<void> {
  if (!text) return;
  await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        await telegram.sendMessage(chatId, text);
      } catch (error) {
        console.error(`Could not notify chat ${chatId}:`, error);
      }
    }),
  );
}
