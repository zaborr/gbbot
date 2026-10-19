import {
  isSaleStatus,
  type ExportRequest,
  type ExportScope,
  type Lang,
  type Order,
} from '@tma-shop/shared';
import { buildCsv, buildXlsx, type CellValue, type Sheet } from './xlsx.js';

export interface CustomerInfo {
  name: string;
  username: string | null;
}

export interface ReportInput {
  shopName: string;
  shopSlug: string;
  feeLabel: string;
  orders: Order[];
  customers: Map<number, CustomerInfo>;
  request: ExportRequest;
  now?: Date;
  /** Language of the sheet names, headers and labels (the admin's). */
  lang?: Lang;
}

export interface ReportFile {
  fileName: string;
  contentType: string;
  data: Buffer;
  orderCount: number;
}

const TEXT = {
  en: {
    'scope.paid': 'Paid (incl. shipped and delivered)',
    'scope.toFulfil': 'Paid, not shipped yet',
    'scope.shipped': 'Shipped',
    'scope.fulfilled': 'Delivered',
    'scope.unpaid': 'Not paid / verifying',
    'scope.cancelled': 'Cancelled',
    'scope.all': 'All orders',
    'status.pending': 'Not paid',
    'status.awaiting_payment': 'Verifying payment',
    'status.paid': 'Paid',
    'status.shipped': 'Shipped',
    'status.fulfilled': 'Delivered',
    'status.cancelled': 'Cancelled',
    'note.change': 'Change requested',
    'note.refund': 'Refund owed',
    'note.difference': 'Difference due',
    'note.anonymized': 'Anonymized',
    'sheet.summary': 'Summary',
    'sheet.orders': 'Orders',
    'sheet.lines': 'Lines',
    'sheet.products': 'Products',
    'col.order': 'Order',
    'col.date': 'Date',
    'col.status': 'Status',
    'col.customer': 'Customer',
    'col.username': 'Username',
    'col.telegramId': 'Telegram ID',
    'col.zone': 'Shipping zone',
    'col.currency': 'Currency',
    'col.units': 'Units',
    'col.products': 'Products',
    'col.shipping': 'Shipping',
    'col.total': 'Total',
    'col.paid': 'Paid',
    'col.balance': 'Balance (+due / −refund)',
    'col.method': 'Payment method',
    'col.tx': 'Transaction',
    'col.tracking': 'Tracking',
    'col.notes': 'Notes',
    'col.items': 'Items',
    'col.product': 'Product',
    'col.variant': 'Variant',
    'col.quantity': 'Quantity',
    'col.unitPrice': 'Unit price',
    'col.subtotal': 'Subtotal',
    'col.revenue': 'Revenue',
    'col.orders': 'Orders',
    'sum.shop': 'GB',
    'sum.included': 'Orders included',
    'sum.from': 'From',
    'sum.to': 'To',
    'sum.beginning': 'Beginning',
    'sum.now': 'Now',
    'sum.generated': 'Generated',
  },
  es: {
    'scope.paid': 'Pagados (incluye enviados y entregados)',
    'scope.toFulfil': 'Pagados, sin enviar',
    'scope.shipped': 'Enviados',
    'scope.fulfilled': 'Entregados',
    'scope.unpaid': 'Sin pagar / en revisión',
    'scope.cancelled': 'Cancelados',
    'scope.all': 'Todos los pedidos',
    'status.pending': 'Sin pagar',
    'status.awaiting_payment': 'Comprobando el pago',
    'status.paid': 'Pagado',
    'status.shipped': 'Enviado',
    'status.fulfilled': 'Entregado',
    'status.cancelled': 'Cancelado',
    'note.change': 'Cambio solicitado',
    'note.refund': 'Devolución pendiente',
    'note.difference': 'Diferencia pendiente',
    'note.anonymized': 'Anonimizado',
    'sheet.summary': 'Resumen',
    'sheet.orders': 'Pedidos',
    'sheet.lines': 'Líneas',
    'sheet.products': 'Productos',
    'col.order': 'Pedido',
    'col.date': 'Fecha',
    'col.status': 'Estado',
    'col.customer': 'Cliente',
    'col.username': 'Usuario',
    'col.telegramId': 'ID de Telegram',
    'col.zone': 'Zona de envío',
    'col.currency': 'Moneda',
    'col.units': 'Unidades',
    'col.products': 'Productos',
    'col.shipping': 'Envío',
    'col.total': 'Total',
    'col.paid': 'Pagado',
    'col.balance': 'Saldo (+pendiente / −devolver)',
    'col.method': 'Forma de pago',
    'col.tx': 'Transacción',
    'col.tracking': 'Seguimiento',
    'col.notes': 'Notas',
    'col.items': 'Artículos',
    'col.product': 'Producto',
    'col.variant': 'Variante',
    'col.quantity': 'Cantidad',
    'col.unitPrice': 'Precio unitario',
    'col.subtotal': 'Subtotal',
    'col.revenue': 'Ingresos',
    'col.orders': 'Pedidos',
    'sum.shop': 'GB',
    'sum.included': 'Pedidos incluidos',
    'sum.from': 'Desde',
    'sum.to': 'Hasta',
    'sum.beginning': 'El principio',
    'sum.now': 'Ahora',
    'sum.generated': 'Generado',
  },
  it: {
    'scope.paid': 'Pagati (inclusi spediti e consegnati)',
    'scope.toFulfil': 'Pagati, non ancora spediti',
    'scope.shipped': 'Spediti',
    'scope.fulfilled': 'Consegnati',
    'scope.unpaid': 'Non pagati / in verifica',
    'scope.cancelled': 'Annullati',
    'scope.all': 'Tutti gli ordini',
    'status.pending': 'Non pagato',
    'status.awaiting_payment': 'Verifica del pagamento',
    'status.paid': 'Pagato',
    'status.shipped': 'Spedito',
    'status.fulfilled': 'Consegnato',
    'status.cancelled': 'Annullato',
    'note.change': 'Modifica richiesta',
    'note.refund': 'Rimborso dovuto',
    'note.difference': 'Differenza da pagare',
    'note.anonymized': 'Anonimizzato',
    'sheet.summary': 'Riepilogo',
    'sheet.orders': 'Ordini',
    'sheet.lines': 'Righe',
    'sheet.products': 'Prodotti',
    'col.order': 'Ordine',
    'col.date': 'Data',
    'col.status': 'Stato',
    'col.customer': 'Cliente',
    'col.username': 'Username',
    'col.telegramId': 'ID Telegram',
    'col.zone': 'Zona di spedizione',
    'col.currency': 'Valuta',
    'col.units': 'Unità',
    'col.products': 'Prodotti',
    'col.shipping': 'Spedizione',
    'col.total': 'Totale',
    'col.paid': 'Pagato',
    'col.balance': 'Saldo (+dovuto / −da rimborsare)',
    'col.method': 'Metodo di pagamento',
    'col.tx': 'Transazione',
    'col.tracking': 'Tracciamento',
    'col.notes': 'Note',
    'col.items': 'Articoli',
    'col.product': 'Prodotto',
    'col.variant': 'Variante',
    'col.quantity': 'Quantità',
    'col.unitPrice': 'Prezzo unitario',
    'col.subtotal': 'Subtotale',
    'col.revenue': 'Ricavi',
    'col.orders': 'Ordini',
    'sum.shop': 'GB',
    'sum.included': 'Ordini inclusi',
    'sum.from': 'Dal',
    'sum.to': 'Al',
    'sum.beginning': 'Inizio',
    'sum.now': 'Oggi',
    'sum.generated': 'Generato',
  },
  pt: {
    'scope.paid': 'Pagos (inclui enviados e entregues)',
    'scope.toFulfil': 'Pagos, ainda não enviados',
    'scope.shipped': 'Enviados',
    'scope.fulfilled': 'Entregues',
    'scope.unpaid': 'Não pagos / em verificação',
    'scope.cancelled': 'Cancelados',
    'scope.all': 'Todos os pedidos',
    'status.pending': 'Não pago',
    'status.awaiting_payment': 'A verificar o pagamento',
    'status.paid': 'Pago',
    'status.shipped': 'Enviado',
    'status.fulfilled': 'Entregue',
    'status.cancelled': 'Cancelado',
    'note.change': 'Alteração pedida',
    'note.refund': 'Reembolso pendente',
    'note.difference': 'Diferença por pagar',
    'note.anonymized': 'Anonimizado',
    'sheet.summary': 'Resumo',
    'sheet.orders': 'Pedidos',
    'sheet.lines': 'Linhas',
    'sheet.products': 'Produtos',
    'col.order': 'Pedido',
    'col.date': 'Data',
    'col.status': 'Estado',
    'col.customer': 'Cliente',
    'col.username': 'Utilizador',
    'col.telegramId': 'ID do Telegram',
    'col.zone': 'Zona de envio',
    'col.currency': 'Moeda',
    'col.units': 'Unidades',
    'col.products': 'Produtos',
    'col.shipping': 'Envio',
    'col.total': 'Total',
    'col.paid': 'Pago',
    'col.balance': 'Saldo (+por pagar / −a reembolsar)',
    'col.method': 'Método de pagamento',
    'col.tx': 'Transação',
    'col.tracking': 'Rastreio',
    'col.notes': 'Notas',
    'col.items': 'Artigos',
    'col.product': 'Produto',
    'col.variant': 'Variante',
    'col.quantity': 'Quantidade',
    'col.unitPrice': 'Preço unitário',
    'col.subtotal': 'Subtotal',
    'col.revenue': 'Receita',
    'col.orders': 'Pedidos',
    'sum.shop': 'GB',
    'sum.included': 'Pedidos incluídos',
    'sum.from': 'De',
    'sum.to': 'Até',
    'sum.beginning': 'Início',
    'sum.now': 'Agora',
    'sum.generated': 'Gerado',
  },
} as const;

type TextKey = keyof (typeof TEXT)['en'];

/** Labels in the report's language. */
function labels(input: ReportInput): (key: TextKey) => string {
  const table: Record<TextKey, string> = TEXT[input.lang ?? 'en'];
  return (key) => table[key];
}

function statusText(L: (key: TextKey) => string, status: Order['status']): string {
  return L(`status.${status}`);
}

export function matchesScope(order: Order, scope: ExportScope): boolean {
  switch (scope) {
    case 'paid':
      return isSaleStatus(order.status);
    case 'toFulfil':
      return order.status === 'paid';
    case 'shipped':
      return order.status === 'shipped';
    case 'fulfilled':
      return order.status === 'fulfilled';
    case 'unpaid':
      return order.status === 'pending' || order.status === 'awaiting_payment';
    case 'cancelled':
      return order.status === 'cancelled';
    case 'all':
      return true;
  }
}

/** Orders in scope and in the [from, to) date range, oldest first. */
export function selectOrders(orders: readonly Order[], request: ExportRequest): Order[] {
  const from = request.from ? Date.parse(request.from) : -Infinity;
  const to = request.to ? Date.parse(request.to) : Infinity;
  return orders
    .filter((o) => {
      const created = Date.parse(o.createdAt);
      return matchesScope(o, request.scope) && created >= from && created < to;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Amount in token units as a spreadsheet number (stored in cents). */
function money(amount: number): CellValue {
  return { money: amount / 100 };
}

function itemName(item: Order['items'][number]): string {
  return item.variantLabel ? `${item.title} (${item.variantLabel})` : item.title;
}

function notes(L: (key: TextKey) => string, order: Order): string {
  const parts: string[] = [];
  if (order.changeRequest) parts.push(L('note.change'));
  if (order.amountDue < 0) parts.push(L('note.refund'));
  if (order.amountDue > 0 && order.amountPaid > 0) parts.push(L('note.difference'));
  if (order.anonymizedAt) parts.push(L('note.anonymized'));
  return parts.join('; ');
}

function ordersSheet(input: ReportInput, orders: readonly Order[]): Sheet {
  const L = labels(input);
  const header: CellValue[] = [
    L('col.order'),
    L('col.date'),
    L('col.status'),
    L('col.customer'),
    L('col.username'),
    L('col.telegramId'),
    L('col.zone'),
    L('col.currency'),
    L('col.units'),
    L('col.products'),
    input.feeLabel,
    L('col.shipping'),
    L('col.total'),
    L('col.paid'),
    L('col.balance'),
    L('col.method'),
    L('col.tx'),
    L('col.tracking'),
    L('col.notes'),
    L('col.items'),
  ];
  const rows = orders.map((o): CellValue[] => {
    const customer = o.userId === null ? undefined : input.customers.get(o.userId);
    const products = o.items.reduce((sum, i) => sum + i.subtotal, 0);
    const username = o.contactUsername ?? customer?.username ?? null;
    return [
      `#${o.id.slice(0, 8)}`,
      { date: new Date(o.createdAt) },
      statusText(L, o.status),
      customer?.name ?? '',
      username ? `@${username}` : '',
      o.userId ?? '',
      o.shippingZoneName ?? '',
      o.currency,
      o.items.reduce((n, i) => n + i.quantity, 0),
      money(products),
      money(o.fee),
      money(o.shipping),
      money(o.total),
      money(o.amountPaid),
      money(o.amountDue),
      o.paymentNetwork ?? '',
      o.paymentTxHash
        ? o.paymentTxUrl
          ? { link: o.paymentTxUrl, text: o.paymentTxHash }
          : o.paymentTxHash
        : '',
      o.trackingNumber ?? '',
      notes(L, o),
      o.items.map((i) => `${i.quantity}× ${itemName(i)}`).join(', '),
    ];
  });
  return {
    name: L('sheet.orders'),
    rows: [header, ...rows],
    widths: [11, 17, 17, 20, 18, 13, 16, 9, 7, 11, 11, 10, 11, 11, 14, 16, 30, 18, 18, 50],
  };
}

function linesSheet(input: ReportInput, orders: readonly Order[]): Sheet {
  const L = labels(input);
  const header: CellValue[] = [
    L('col.order'),
    L('col.date'),
    L('col.status'),
    L('col.username'),
    L('col.product'),
    L('col.variant'),
    L('col.quantity'),
    L('col.unitPrice'),
    L('col.subtotal'),
    L('col.currency'),
  ];
  const rows = orders.flatMap((o) =>
    o.items.map((i): CellValue[] => [
      `#${o.id.slice(0, 8)}`,
      { date: new Date(o.createdAt) },
      statusText(L, o.status),
      o.contactUsername ? `@${o.contactUsername}` : '',
      i.title,
      i.variantLabel ?? '',
      i.quantity,
      money(i.unitPrice),
      money(i.subtotal),
      o.currency,
    ]),
  );
  return {
    name: L('sheet.lines'),
    rows: [header, ...rows],
    widths: [11, 17, 17, 18, 28, 18, 9, 11, 11, 9],
  };
}

function productsSheet(input: ReportInput, orders: readonly Order[]): Sheet {
  const L = labels(input);
  const totals = new Map<
    string,
    { title: string; variant: string; currency: string; units: number; revenue: number; orders: Set<string> }
  >();
  for (const o of orders) {
    for (const i of o.items) {
      const key = `${i.productId}:${i.variantId ?? ''}:${o.currency}`;
      const row = totals.get(key) ?? {
        title: i.title,
        variant: i.variantLabel ?? '',
        currency: o.currency,
        units: 0,
        revenue: 0,
        orders: new Set<string>(),
      };
      row.units += i.quantity;
      row.revenue += i.subtotal;
      row.orders.add(o.id);
      totals.set(key, row);
    }
  }
  const rows = [...totals.values()]
    .sort((a, b) => b.units - a.units || a.title.localeCompare(b.title))
    .map((r): CellValue[] => [
      r.title,
      r.variant,
      r.currency,
      r.units,
      money(r.revenue),
      r.orders.size,
    ]);
  return {
    name: L('sheet.products'),
    rows: [
      [
        L('col.product'),
        L('col.variant'),
        L('col.currency'),
        L('col.units'),
        L('col.revenue'),
        L('col.orders'),
      ],
      ...rows,
    ],
    widths: [30, 20, 9, 8, 12, 8],
  };
}

function summarySheet(input: ReportInput, orders: readonly Order[], now: Date): Sheet {
  const L = labels(input);
  const byCurrency = new Map<
    string,
    { orders: number; units: number; products: number; fees: number; shipping: number; total: number; paid: number }
  >();
  for (const o of orders) {
    const row = byCurrency.get(o.currency) ?? {
      orders: 0,
      units: 0,
      products: 0,
      fees: 0,
      shipping: 0,
      total: 0,
      paid: 0,
    };
    row.orders += 1;
    row.units += o.items.reduce((n, i) => n + i.quantity, 0);
    row.products += o.items.reduce((n, i) => n + i.subtotal, 0);
    row.fees += o.fee;
    row.shipping += o.shipping;
    row.total += o.total;
    row.paid += o.amountPaid;
    byCurrency.set(o.currency, row);
  }
  const { request } = input;
  const rows: CellValue[][] = [
    [
      L('col.currency'),
      L('col.orders'),
      L('col.units'),
      L('col.products'),
      input.feeLabel,
      L('col.shipping'),
      L('col.total'),
      L('col.paid'),
    ],
    ...[...byCurrency.entries()].map(([currency, r]): CellValue[] => [
      currency,
      r.orders,
      r.units,
      money(r.products),
      money(r.fees),
      money(r.shipping),
      money(r.total),
      money(r.paid),
    ]),
    [],
    [L('sum.shop'), input.shopName],
    [L('sum.included'), L(`scope.${request.scope}`)],
    [L('sum.from'), request.from ? { date: new Date(request.from) } : L('sum.beginning')],
    [L('sum.to'), request.to ? { date: new Date(request.to) } : L('sum.now')],
    [L('sum.generated'), { date: now }],
  ];
  return { name: L('sheet.summary'), rows, widths: [18, 24, 9, 12, 12, 11, 12, 12], filter: false };
}

function dateStamp(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Builds the requested report file for a shop's orders. */
export function buildReport(input: ReportInput): ReportFile {
  const now = input.now ?? new Date();
  const timeZone = input.request.timeZone ?? 'UTC';
  const orders = selectOrders(input.orders, input.request);
  const base = `${input.shopSlug}-orders-${input.request.scope}-${dateStamp(now, timeZone)}`;

  switch (input.request.format) {
    case 'xlsx':
      return {
        fileName: `${base}.xlsx`,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: buildXlsx(
          [
            summarySheet(input, orders, now),
            ordersSheet(input, orders),
            linesSheet(input, orders),
            productsSheet(input, orders),
          ],
          { timeZone },
        ),
        orderCount: orders.length,
      };
    case 'csv-orders':
      return {
        fileName: `${base}.csv`,
        contentType: 'text/csv',
        data: buildCsv(ordersSheet(input, orders).rows, { timeZone }),
        orderCount: orders.length,
      };
    case 'csv-lines':
      return {
        fileName: `${base}-lines.csv`,
        contentType: 'text/csv',
        data: buildCsv(linesSheet(input, orders).rows, { timeZone }),
        orderCount: orders.length,
      };
  }
}
