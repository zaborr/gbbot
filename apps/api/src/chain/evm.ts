import { jsonRpc, type Fetch, type TxCheck } from './types.js';

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 transfer event. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface Receipt {
  status: string;
  blockNumber: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * How much of `token` (contract) the transaction `txHash` sent to `to`, once it
 * has `minConfirmations` blocks on top.
 */
export async function checkEvmTransfer(
  rpcUrl: string,
  txHash: string,
  token: string,
  to: string,
  minConfirmations: number,
  fetchImpl: Fetch = fetch,
): Promise<TxCheck> {
  const receipt = await jsonRpc<Receipt | null>(rpcUrl, 'eth_getTransactionReceipt', [txHash], fetchImpl);
  if (!receipt) return { state: 'pending' };
  if (receipt.status !== '0x1') return { state: 'failed' };

  const latest = BigInt(await jsonRpc<string>(rpcUrl, 'eth_blockNumber', [], fetchImpl));
  const block = BigInt(receipt.blockNumber);
  if (latest - block + 1n < BigInt(minConfirmations)) return { state: 'pending' };

  const header = await jsonRpc<{ timestamp: string } | null>(
    rpcUrl,
    'eth_getBlockByNumber',
    [receipt.blockNumber, false],
    fetchImpl,
  );
  if (!header) return { state: 'pending' };

  const contract = token.toLowerCase();
  const recipient = to.toLowerCase().replace(/^0x/, '');
  let amount = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const toTopic = log.topics[2]?.toLowerCase() ?? '';
    if (toTopic.slice(-40) !== recipient) continue;
    amount += BigInt(log.data === '0x' ? 0 : log.data);
  }
  return { state: 'ok', timestamp: Number(BigInt(header.timestamp)), amount };
}
