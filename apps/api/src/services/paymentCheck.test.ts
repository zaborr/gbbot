import { describe, expect, it } from 'vitest';
import { checkEvmTransfer } from '../chain/evm.js';
import { checkSolanaTransfer } from '../chain/solana.js';
import { decide } from './paymentCheck.js';

const order = {
  createdAt: new Date('2026-10-14T10:00:00Z'),
  total: 2500,
  amountPaid: 0,
  currency: 'USDC',
};
const at = (iso: string): number => Date.parse(iso) / 1000;
const money = (cents: number): string => `${(cents / 100).toFixed(2)} USDC`;

describe('decide', () => {
  it('confirms a matching payment after the order', () => {
    expect(
      decide({ state: 'ok', timestamp: at('2026-10-14T10:05:00Z'), amount: 25_000_000n }, order, 0, money),
    ).toEqual({ status: 'verified', received: 2500 });
  });

  it('accepts overpayments (the refund is tracked on the order)', () => {
    expect(
      decide({ state: 'ok', timestamp: at('2026-10-14T10:05:00Z'), amount: 26_000_000n }, order, 0, money),
    ).toEqual({ status: 'verified', received: 2600 });
  });

  it('refuses short, old, empty, failed or ambiguous payments', () => {
    const later = at('2026-10-14T10:05:00Z');
    expect(decide({ state: 'ok', timestamp: later, amount: 24_000_000n }, order, 0, money)).toMatchObject({
      reason: 'short',
      vars: { received: '24.00 USDC', expected: '25.00 USDC' },
    });
    expect(
      decide({ state: 'ok', timestamp: at('2026-10-14T09:00:00Z'), amount: 25_000_000n }, order, 0, money),
    ).toMatchObject({ reason: 'too_old' });
    expect(decide({ state: 'ok', timestamp: later, amount: 0n }, order, 0, money)).toMatchObject({
      reason: 'no_transfer',
    });
    expect(decide({ state: 'failed' }, order, 0, money)).toMatchObject({ reason: 'tx_failed' });
    expect(decide({ state: 'ok', timestamp: later, amount: 25_000_000n }, order, 1, money)).toMatchObject({
      reason: 'ambiguous',
      vars: { count: 2 },
    });
  });
});

/** A fake JSON-RPC node answering by method name. */
function fakeRpc(answers: Record<string, unknown>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: answers[method] ?? null }));
  }) as typeof fetch;
}

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SHOP = '0x1111111111111111111111111111111111111111';
const pad = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

describe('checkEvmTransfer', () => {
  it('adds up USDC transfers to the shop and ignores other tokens', async () => {
    const result = await checkEvmTransfer(
      'https://rpc',
      `0x${'a'.repeat(64)}`,
      USDC_BASE,
      SHOP,
      3,
      fakeRpc({
        eth_getTransactionReceipt: {
          status: '0x1',
          blockNumber: '0x10',
          logs: [
            {
              address: USDC_BASE.toLowerCase(),
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                pad('0x2222222222222222222222222222222222222222'),
                pad(SHOP),
              ],
              data: '0x' + (25_000_000).toString(16).padStart(64, '0'),
            },
            {
              address: '0x9999999999999999999999999999999999999999',
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                pad('0x2222222222222222222222222222222222222222'),
                pad(SHOP),
              ],
              data: '0x' + (99).toString(16).padStart(64, '0'),
            },
          ],
        },
        eth_blockNumber: '0x20',
        eth_getBlockByNumber: { timestamp: '0x6700' },
      }),
    );
    expect(result).toEqual({ state: 'ok', timestamp: 0x6700, amount: 25_000_000n });
  });

  it('waits while the transaction is not mined or not confirmed enough', async () => {
    expect(
      await checkEvmTransfer('https://rpc', '0x', USDC_BASE, SHOP, 3, fakeRpc({ eth_getTransactionReceipt: null })),
    ).toEqual({ state: 'pending' });
    expect(
      await checkEvmTransfer(
        'https://rpc',
        '0x',
        USDC_BASE,
        SHOP,
        3,
        fakeRpc({
          eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x10', logs: [] },
          eth_blockNumber: '0x11',
        }),
      ),
    ).toEqual({ state: 'pending' });
  });
});

describe('checkSolanaTransfer', () => {
  it('measures what the shop wallet received of the mint', async () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const owner = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const result = await checkSolanaTransfer(
      'https://rpc',
      'sig',
      mint,
      owner,
      fakeRpc({
        getTransaction: {
          blockTime: 1_700_000_000,
          meta: {
            err: null,
            preTokenBalances: [{ mint, owner, uiTokenAmount: { amount: '1000000' } }],
            postTokenBalances: [{ mint, owner, uiTokenAmount: { amount: '26000000' } }],
          },
        },
      }),
    );
    expect(result).toEqual({ state: 'ok', timestamp: 1_700_000_000, amount: 25_000_000n });
  });
});

describe('decide, paid in the other token', () => {
  // 25.00 EURC at 1 EURC = 1.0835 USDC: 27.0875 → 27.09 USDC (rounded up).
  const euros = { ...order, currency: 'EURC', paymentExchange: { token: 'USDC', rate: 10_835 } };
  const usdc = (cents: number): string => `${(cents / 100).toFixed(2)} USDC`;

  it('checks the converted amount and credits it back in the order currency', () => {
    expect(
      decide({ state: 'ok', timestamp: at('2026-10-14T10:05:00Z'), amount: 27_090_000n }, euros, 0, usdc),
    ).toEqual({ status: 'verified', received: 2500, receivedInToken: 2709 });
  });

  it('reports a short payment in the token paid', () => {
    expect(
      decide({ state: 'ok', timestamp: at('2026-10-14T10:05:00Z'), amount: 27_080_000n }, euros, 0, usdc),
    ).toMatchObject({ status: 'failed', reason: 'short', vars: { received: '27.08 USDC', expected: '27.09 USDC' } });
  });
});
