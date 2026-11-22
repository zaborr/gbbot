import type { Order } from './order.js';

/** Units of one product (or variant) a buyer has, by where they are. */
export interface BuyerProduct {
  /** productId or productId:variantId. */
  key: string;
  title: string;
  variantLabel: string | null;
  /** Ordered and not paid yet. */
  unpaid: number;
  /** Paid, to send. */
  paid: number;
  /** Sent or delivered. */
  shipped: number;
}

/** One person in a GB's list of buyers: what they have across all their orders. */
export interface BuyerSummary {
  telegramId: number;
  name: string;
  username: string | null;
  orders: number;
  /** Units ordered (not cancelled). */
  units: number;
  currency: string;
  /** Money received, net of refunds. */
  paid: number;
  /** Still owed on their orders. */
  owed: number;
  /** Some order waits for their payment. */
  unpaid: boolean;
  /** Something paid and not sent yet. */
  toShip: boolean;
  /** Takes part in a testing. */
  testing: boolean;
  /** Units in their cart, not ordered yet. */
  cartUnits: number;
  /** A VIP of the GB now (its lists or VIP groups). */
  vip: boolean;
  /** In the GB's or the platform's blacklist. */
  blocked: boolean;
  products: BuyerProduct[];
}

export interface BuyerTesting {
  id: string;
  label: string;
  volunteer: boolean;
  donor: boolean;
  paid: boolean;
}

/** A buyer in full: their products, cart, orders and testings. */
export interface BuyerDetail extends BuyerSummary {
  cart: Array<{ title: string; variantLabel: string | null; quantity: number }>;
  orderList: Order[];
  testings: BuyerTesting[];
}
