import { CHAINS, chainId, type PaymentMethod } from '@tma-shop/shared';

/** Human label stored on the order, e.g. "USDC · Base". */
export function paymentMethodLabel(method: PaymentMethod): string {
  return `${method.token} · ${method.network}`;
}

/**
 * Builds a block-explorer link for a transaction. `paymentNetwork` is the label
 * stored on the order ("USDC · Base").
 */
export function explorerTxUrl(paymentNetwork: string | null, txHash: string | null): string | null {
  if (!paymentNetwork || !txHash) return null;
  const network = (paymentNetwork.split('·').pop() ?? '').trim().toLowerCase();
  const chain = chainId.options.find((id) => network.startsWith(id));
  return chain ? `${CHAINS[chain].explorerTx}${encodeURIComponent(txHash)}` : null;
}
