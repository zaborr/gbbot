import { z } from 'zod';

/**
 * Networks and tokens the shop accepts, with their official contracts (Circle).
 * A closed list: payments can be checked on-chain and nothing depends on how
 * an admin spells a network name.
 */
export const CHAINS = {
  base: { name: 'Base', family: 'evm', explorerTx: 'https://basescan.org/tx/' },
  solana: { name: 'Solana', family: 'solana', explorerTx: 'https://solscan.io/tx/' },
  ethereum: { name: 'Ethereum', family: 'evm', explorerTx: 'https://etherscan.io/tx/' },
} as const;

export const chainId = z.enum(['base', 'solana', 'ethereum']);
export type ChainId = z.infer<typeof chainId>;

export const stableToken = z.enum(['USDC', 'EURC']);
export type StableToken = z.infer<typeof stableToken>;

/** Official token contracts (EVM) and mints (Solana). Both tokens use 6 decimals. */
export const TOKEN_CONTRACTS: Record<ChainId, Record<StableToken, string>> = {
  base: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    EURC: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
  },
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    EURC: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
  },
  solana: {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    EURC: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
  },
};
export const TOKEN_DECIMALS = 6;

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A way to pay outside the blockchain (Wise, Bizum, Revolut…): the customer
 * follows the instructions, says they paid, and an admin checks it by hand.
 */
export const manualPaymentMethod = z.object({
  id: z.string().min(1).max(64),
  /** Shown to customers, e.g. "Wise". */
  name: z.string().trim().min(1).max(40),
  /** How to pay, e.g. "Send the amount to @pepepe". */
  instructions: z.string().trim().min(1).max(1000),
  isActive: z.boolean(),
});
export type ManualPaymentMethod = z.infer<typeof manualPaymentMethod>;

/** Id prefix of manual methods in an order's `paymentMethodId`. */
export const MANUAL_METHOD_PREFIX = 'manual:';

/** Exchange rates are stored ×10 000: 11 000 = 1.10. */
export const RATE_SCALE = 10_000;
const exchangeRate = z.number().int().min(1).max(100 * RATE_SCALE);

/**
 * Paying in the other token: for a price in the key's token, how many units of
 * the other token per unit (×RATE_SCALE). `EURC: 11000` = a 1 € price is paid
 * with 1.10 USDC. Null = that direction is not offered.
 */
export const exchangeRates = z.object({
  EURC: exchangeRate.nullable(),
  USDC: exchangeRate.nullable(),
});
export type ExchangeRates = z.infer<typeof exchangeRates>;
export const NO_EXCHANGE: ExchangeRates = { EURC: null, USDC: null };

/**
 * The rate to pay a price in `currency` with `token`: RATE_SCALE for the same
 * token, null when the shop does not offer that exchange.
 */
export function exchangeRateFor(
  rates: ExchangeRates | null | undefined,
  currency: string,
  token: string,
): number | null {
  if (currency === token) return RATE_SCALE;
  if (currency === 'EURC' && token === 'USDC') return rates?.EURC ?? null;
  if (currency === 'USDC' && token === 'EURC') return rates?.USDC ?? null;
  return null;
}

/** `cents` of the price converted at `rate`, rounded up (the shop never gets less). */
export function convertAmount(cents: number, rate: number): number {
  return Math.ceil((cents * rate) / RATE_SCALE);
}

/** What `paid` (in the other token) is worth in the price's token, rounded down. */
export function convertBack(paid: number, rate: number): number {
  return Math.floor((paid * RATE_SCALE) / rate);
}

/** How a shop gets paid: one EVM address, one Solana address, and what it accepts. */
export const paymentSetup = z.object({
  /** Receives payments on Base and Ethereum. */
  evmAddress: z.string().trim().regex(EVM_ADDRESS_RE).nullable(),
  /** Receives payments on Solana. */
  solanaAddress: z.string().trim().regex(SOLANA_ADDRESS_RE).nullable(),
  /** Network + token pairs the shop accepts. */
  accepted: z.array(z.object({ chain: chainId, token: stableToken })).max(12),
  /** Other ways to pay, checked by hand (missing in setups saved before they existed). */
  manual: z.array(manualPaymentMethod).max(10).optional(),
  /** Paying in the other token (missing in setups saved before it existed). */
  exchange: exchangeRates.optional(),
});
export type PaymentSetup = z.infer<typeof paymentSetup>;

export const EMPTY_PAYMENT_SETUP: PaymentSetup = {
  evmAddress: null,
  solanaAddress: null,
  accepted: [],
  manual: [],
  exchange: NO_EXCHANGE,
};

/** A manual method as customers see it (active ones only). */
export const manualMethodView = manualPaymentMethod.pick({ id: true, name: true, instructions: true });
export type ManualMethodView = z.infer<typeof manualMethodView>;

/** The shop's active manual methods, in the order the admin listed them. */
export function manualMethodsOf(setup: PaymentSetup | null | undefined): ManualMethodView[] {
  return (setup?.manual ?? [])
    .filter((m) => m.isActive)
    .map(({ id, name, instructions }) => ({ id, name, instructions }));
}

/**
 * The amount as money for a manual method: EURC is shown as euros and USDC as
 * dollars, one to one.
 */
export function fiatCurrencyOf(token: string): 'EUR' | 'USD' | null {
  return token === 'EURC' ? 'EUR' : token === 'USDC' ? 'USD' : null;
}

/** The address that receives payments on `chain`, if the shop set one. */
export function addressFor(setup: PaymentSetup, chain: ChainId): string | null {
  return CHAINS[chain].family === 'evm' ? setup.evmAddress : setup.solanaAddress;
}

/**
 * A way to pay (one network + one token) offered to customers, derived from
 * the shop's payment setup.
 */
export const paymentMethod = z.object({
  /** Stable identifier, e.g. `usdc-base`. */
  id: z.string().min(1).max(64),
  chain: chainId,
  /** Network name shown to the customer, e.g. `Base`. */
  network: z.string().min(1).max(64),
  token: stableToken,
  /** Receiving address on that network. */
  address: z.string().min(1).max(128),
  /** Token contract (EVM) or mint (Solana). */
  contract: z.string(),
});
export type PaymentMethod = z.infer<typeof paymentMethod>;

/** Payment methods a shop offers, in catalog order, skipping those without an address. */
export function paymentMethodsOf(setup: PaymentSetup | null | undefined): PaymentMethod[] {
  const current = setup ?? EMPTY_PAYMENT_SETUP;
  const methods: PaymentMethod[] = [];
  for (const chain of chainId.options) {
    const address = addressFor(current, chain);
    if (!address) continue;
    for (const token of stableToken.options) {
      if (!current.accepted.some((a) => a.chain === chain && a.token === token)) continue;
      methods.push({
        id: `${token.toLowerCase()}-${chain}`,
        chain,
        network: CHAINS[chain].name,
        token,
        address,
        contract: TOKEN_CONTRACTS[chain][token],
      });
    }
  }
  return methods;
}
