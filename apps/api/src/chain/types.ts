/** What the blockchain says about a transaction, from the shop's point of view. */
export type TxCheck =
  /** Not found (yet), or not confirmed enough. Worth trying again later. */
  | { state: 'pending' }
  /** Included but reverted / failed. */
  | { state: 'failed' }
  /** Confirmed: block time (seconds) and raw token units received by the shop. */
  | { state: 'ok'; timestamp: number; amount: bigint };

export type Fetch = typeof fetch;

/** Minimal JSON-RPC 2.0 call. Throws on transport or RPC errors. */
export async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: Fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
  return body.result as T;
}
