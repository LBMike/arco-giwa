import { ensure } from './contracts.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * Stocks settles on GIWA's own confirmation, the same boundary Savings and Funds use.
 *
 * GIWA Sepolia is an OP Stack L2. Its `finalized` tag only moves once the batch holding a GIWA block
 * is final on Ethereum, about 18 minutes later. This transport answers every
 * `eth_getBlockByNumber('finalized')` with the block GIWA_CONFIRMATION_DEPTH below the GIWA head
 * instead, so deposits, escrows, mints and payouts count seconds after GIWA includes them. All other
 * requests pass through unchanged.
 *
 * The small depth keeps reads at a height every public RPC node already serves, and the boundary never
 * moves backwards between calls. Callers keep their own checks: a reorganisation of a block they
 * already used still changes its hash, which stops the observer and the evidence reads for review.
 */
export const GIWA_CONFIRMATION_DEPTH = 2n;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;

export function giwaConfirmedTransport(inner: JsonRpcTransport, depth: bigint = GIWA_CONFIRMATION_DEPTH): JsonRpcTransport {
  ensure(typeof inner === 'function' && typeof depth === 'bigint' && depth >= 0n && depth <= 64n, 'INVALID_GIWA_CONFIRMATION', 500);
  let floor = -1n;
  return async (method, params) => {
    if (method !== 'eth_getBlockByNumber' || !Array.isArray(params) || params[0] !== 'finalized') return inner(method, params);
    const head = await inner('eth_getBlockByNumber', ['latest', false]);
    if (head === null) return null;
    const number = typeof head === 'object' && !Array.isArray(head) ? (head as Record<string, unknown>).number : undefined;
    ensure(typeof number === 'string' && QUANTITY.test(number), 'MALFORMED_RPC_QUANTITY', 503);
    let target = BigInt(number) > depth ? BigInt(number) - depth : 0n;
    // Another RPC node can briefly report a lower head. The confirmed boundary never goes back.
    if (target < floor) target = floor;
    else floor = target;
    return inner('eth_getBlockByNumber', [`0x${target.toString(16)}`, ...params.slice(1)]);
  };
}
