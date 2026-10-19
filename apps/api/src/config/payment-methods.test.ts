import { describe, expect, it } from 'vitest';
import { paymentMethodsOf } from '@tma-shop/shared';
import { explorerTxUrl } from './payment-methods.js';

const EVM = '0x1111111111111111111111111111111111111111';

describe('paymentMethodsOf', () => {
  it('lists methods in catalog order with the official contract', () => {
    const methods = paymentMethodsOf({
      evmAddress: EVM,
      solanaAddress: null,
      accepted: [
        { chain: 'ethereum', token: 'USDC' },
        { chain: 'base', token: 'EURC' },
        { chain: 'solana', token: 'USDC' },
      ],
    });
    expect(methods.map((m) => m.id)).toEqual(['eurc-base', 'usdc-ethereum']);
    expect(methods[1]?.contract).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });
});

describe('explorerTxUrl', () => {
  it('links to the explorer of the order network', () => {
    expect(explorerTxUrl('USDC · Base', '0xabc')).toBe('https://basescan.org/tx/0xabc');
    expect(explorerTxUrl('USDC · Polygon', '0xabc')).toBeNull();
  });
});
