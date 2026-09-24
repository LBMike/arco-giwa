import { address, freezeManifest, hash, StocksError, type Manifest } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import type { SignerOperation } from './core.js';
import type { OriginalTransactionLookup } from './original-transport.js';

const unavailable = () => new StocksError('SIGNER_ORIGINAL_LOOKUP_UNAVAILABLE', 503);
const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value)) throw unavailable();
  return BigInt(value);
};
const tag = (block: bigint) => `0x${block.toString(16)}`;

/**
 * Find a mined transaction by the physical account's original nonce without a
 * linear history scan. Missing or inconsistent history remains unknown/error;
 * it never permits sending the nonce again. The caller verifies the returned
 * transaction's target, calldata, value and hash before recording anything.
 */
export function createOriginalNonceLookup(options: {
  manifest: Manifest;
  rpc: JsonRpcTransport;
}): OriginalTransactionLookup {
  const manifest = freezeManifest(options.manifest);
  const signer = address(manifest.signerAddress);
  const checkpoint = BigInt(manifest.checkpointNumber);

  async function count(block: bigint): Promise<bigint> {
    return quantity(await options.rpc('eth_getTransactionCount', [signer, tag(block)]));
  }

  return {
    async findAtOriginalNonce(operation: Readonly<SignerOperation>): Promise<unknown> {
      try {
        if (address(operation.call.from) !== signer || !/^(0|[1-9][0-9]{0,77})$/.test(operation.originalNonce))
          throw unavailable();
        const nonce = BigInt(operation.originalNonce);
        if (nonce >= 2n ** 256n) throw unavailable();
        const boundary = await options.rpc('eth_getBlockByNumber', ['finalized', false]);
        if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) throw unavailable();
        const end = quantity((boundary as Record<string, unknown>).number);
        if (end < checkpoint) throw unavailable();
        // A signer nonce already consumed at the deployment checkpoint cannot
        // belong to an operation subsequently reserved by this journal.
        if (await count(checkpoint) > nonce) throw unavailable();
        if (await count(end) <= nonce) return null; // unmined remains unknown
        let low = checkpoint, high = end;
        while (low + 1n < high) {
          const mid = (low + high) / 2n;
          if (await count(mid) > nonce) high = mid;
          else low = mid;
        }
        const block = await options.rpc('eth_getBlockByNumber', [tag(high), true]);
        if (!block || typeof block !== 'object' || Array.isArray(block)) throw unavailable();
        const row = block as Record<string, unknown>;
        if (quantity(row.number) !== high || typeof row.hash !== 'string' || !Array.isArray(row.transactions)) throw unavailable();
        hash(row.hash);
        let found: unknown = null;
        for (const candidate of row.transactions) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw unavailable();
          const tx = candidate as Record<string, unknown>;
          if (address(tx.from as string) !== signer || quantity(tx.nonce) !== nonce) continue;
          if (found !== null) throw unavailable();
          if (tx.blockHash !== row.hash || quantity(tx.blockNumber) !== high) throw unavailable();
          found = candidate;
        }
        if (found === null) throw unavailable(); // provider history/count disagreement
        return found;
      } catch {
        throw unavailable();
      }
    },
  };
}
