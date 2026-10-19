import { jsonRpc, type Fetch, type TxCheck } from './types.js';

interface TokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface SolanaTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
}

export const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

function balanceOf(list: TokenBalance[] | undefined, mint: string, owner: string): bigint {
  return (list ?? [])
    .filter((b) => b.mint === mint && b.owner === owner)
    .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
}

/**
 * How much of the token `mint` the wallet `owner` received in the finalized
 * transaction `signature` (its token balance after minus before).
 */
export async function checkSolanaTransfer(
  rpcUrl: string,
  signature: string,
  mint: string,
  owner: string,
  fetchImpl: Fetch = fetch,
): Promise<TxCheck> {
  const tx = await jsonRpc<SolanaTx | null>(
    rpcUrl,
    'getTransaction',
    [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }],
    fetchImpl,
  );
  if (!tx?.meta || tx.blockTime === null) return { state: 'pending' };
  if (tx.meta.err !== null) return { state: 'failed' };
  const received =
    balanceOf(tx.meta.postTokenBalances, mint, owner) - balanceOf(tx.meta.preTokenBalances, mint, owner);
  return { state: 'ok', timestamp: tx.blockTime, amount: received > 0n ? received : 0n };
}
