import { address, callDigest, hash, StocksError } from '../stocks/contracts.js';
import type { SignerOperation } from './core.js';

const mismatch = () => new StocksError('SIGNER_ORIGINAL_TRANSACTION_MISMATCH', 503);
const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value)) throw mismatch();
  return BigInt(value);
};

/**
 * Verify one RPC transaction against a committed original operation. This is
 * deliberately read-only: a missing candidate is still an unknown outcome and
 * must never authorize another send. The caller must independently bind its
 * RPC to the intended network checkpoint before trusting a candidate.
 */
export function verifyOriginalTransaction(
  operation: Readonly<SignerOperation>, expectedSigner: string, candidate: unknown,
): string | null {
  try {
    const signer = address(expectedSigner);
    if (operation.operationId !== operation.call.operationId
      || operation.callDigest !== callDigest(operation.call)
      || operation.call.chainId !== 91342 || address(operation.call.from) !== signer
      || operation.call.value !== '0' || !/^0x(?:[0-9a-f]{2})+$/.test(operation.call.data)
      || typeof operation.originalNonce !== 'string'
      || !/^(0|[1-9][0-9]{0,77})$/.test(operation.originalNonce)
      || BigInt(operation.originalNonce) >= 2n ** 256n) throw mismatch();
    const target = address(operation.call.to);
    if (candidate === null) return null;
    if (candidate === undefined || typeof candidate !== 'object' || Array.isArray(candidate)) throw mismatch();
    const tx = candidate as Record<string, unknown>;
    if (quantity(tx.chainId) !== BigInt(operation.call.chainId)
      || address(tx.from as string) !== signer
      || quantity(tx.nonce) !== BigInt(operation.originalNonce)
      || address(tx.to as string) !== target
      || tx.input !== operation.call.data
      || quantity(tx.value) !== 0n) throw mismatch();
    return hash(tx.hash as string);
  } catch {
    // Never expose raw RPC content, provider errors or malformed values.
    throw mismatch();
  }
}
