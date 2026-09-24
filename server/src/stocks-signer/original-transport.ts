import { keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { address, callDigest, ensure, freezeManifest, hash, manifestDigest, StocksError, type Manifest } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import { canonicalStocksSignerCall } from '../stocks-runtime/signer-call.js';
import type { OriginalSignerTransport, SignerOperation } from './core.js';
import { verifyOriginalTransaction } from './original-transaction.js';

export type OriginalSignRequest = Readonly<{
  chainId: 91342;
  nonce: bigint;
  to: `0x${string}`;
  data: Hex;
  value: 0n;
}>;

/** This port signs bytes only. It must never broadcast or retry a request. */
export type ExternalTransactionCustody = {
  signOriginal(request: OriginalSignRequest): Promise<unknown>;
};

/** The lookup port returns one RPC transaction at the reserved signer/nonce, or null. */
export type OriginalTransactionLookup = {
  findAtOriginalNonce(operation: Readonly<SignerOperation>): Promise<unknown>;
};

/** Commit the exact signed hash durably before any broadcast. */
export type SignedIntentStore = {
  recordSignedHash(operation: Readonly<SignerOperation>, txHash: string): Promise<string>;
  readSignedHash(operation: Readonly<SignerOperation>): Promise<string | null>;
};

export type SignedTransactionLimits = Readonly<{
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxTotalFeeWei: bigint;
}>;

const invalid = () => new StocksError('SIGNER_SIGNED_TRANSACTION_MISMATCH', 503);
const networkUnavailable = () => new StocksError('SIGNER_NETWORK_UNAVAILABLE', 503);
const originalUnknown = () => new StocksError('SIGNER_ORIGINAL_OUTCOME_UNKNOWN', 503);

function nonce(value: string): bigint {
  ensure(/^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n,
    'SIGNER_RECORD_MISMATCH', 503);
  return BigInt(value);
}

function checkedOperation(manifest: Manifest, operation: Readonly<SignerOperation>): OriginalSignRequest {
  const { call, digest } = canonicalStocksSignerCall(manifest, operation.call);
  ensure(operation.operationId === call.operationId && operation.deploymentDigest === manifestDigest(manifest)
    && operation.callDigest === digest && callDigest(operation.call) === digest,
  'SIGNER_RECORD_MISMATCH', 503);
  return { chainId: 91342, nonce: nonce(operation.originalNonce),
    to: address(call.to) as `0x${string}`, data: call.data as Hex, value: 0n };
}

/** Validate externally signed bytes before the only permitted RPC send. */
export async function verifySignedOriginal(
  request: OriginalSignRequest, expectedSigner: string, raw: unknown, limits: SignedTransactionLimits,
): Promise<{ raw: TransactionSerialized; txHash: Hex }> {
  try {
    if (typeof raw !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(raw) || raw.length > 16386
      || request.nonce > BigInt(Number.MAX_SAFE_INTEGER)
      || limits.maxGas <= 0n || limits.maxFeePerGas <= 0n || limits.maxTotalFeeWei <= 0n) throw invalid();
    const serialized = raw as TransactionSerialized;
    const tx = parseTransaction(serialized);
    // Only an EIP-1559 transaction with explicit fee ceilings is supported.
    // Other transaction families require a separately reviewed fee policy.
    if (tx.type !== 'eip1559' || tx.chainId !== request.chainId
      || tx.nonce === undefined || !Number.isSafeInteger(tx.nonce) || BigInt(tx.nonce) !== request.nonce
      || !tx.to || address(tx.to) !== address(request.to) || tx.data !== request.data
      || (tx.value ?? 0n) !== request.value || !tx.gas || tx.gas <= 0n || tx.gas > limits.maxGas
      || !tx.maxFeePerGas || tx.maxFeePerGas <= 0n || tx.maxFeePerGas > limits.maxFeePerGas
      || tx.maxPriorityFeePerGas === undefined || tx.maxPriorityFeePerGas > tx.maxFeePerGas
      || tx.gas * tx.maxFeePerGas > limits.maxTotalFeeWei
      || (tx.accessList?.length ?? 0) !== 0) throw invalid();
    if (address(await recoverTransactionAddress({ serializedTransaction: serialized })) !== address(expectedSigner)) throw invalid();
    return { raw: serialized, txHash: keccak256(serialized) };
  } catch {
    // Never expose signed bytes or custody/provider error details to the caller.
    throw invalid();
  }
}

/**
 * Inactive, injected one-shot transport. The PostgreSQL journal still owns the
 * durable nonce claim. This module owns no key, listener, retries, or RPC URL.
 */
export function createOriginalSignerTransport(options: {
  manifest: Manifest;
  rpc: JsonRpcTransport;
  custody: ExternalTransactionCustody;
  intent: SignedIntentStore;
  lookup: OriginalTransactionLookup;
  limits: SignedTransactionLimits;
}): OriginalSignerTransport {
  const manifest = freezeManifest(options.manifest);
  const signer = address(manifest.signerAddress);
  const checkpointTag = `0x${BigInt(manifest.checkpointNumber).toString(16)}`;

  async function assertNetwork(): Promise<void> {
    try {
      const chainId = await options.rpc('eth_chainId', []);
      const block = await options.rpc('eth_getBlockByNumber', [checkpointTag, false]);
      if (chainId !== '0x164ce' || !block || typeof block !== 'object' || Array.isArray(block)
        || hash((block as Record<string, unknown>).hash as string) !== manifest.checkpointHash)
        throw networkUnavailable();
    } catch { throw networkUnavailable(); }
  }

  return {
    async sendOnce(operation) {
      const request = checkedOperation(manifest, operation);
      await assertNetwork();
      let signed: { raw: TransactionSerialized; txHash: Hex };
      try {
        signed = await verifySignedOriginal(request, signer, await options.custody.signOriginal(request), options.limits);
      } catch { throw originalUnknown(); }
      // No signed bytes may leave this process until their exact hash is
      // committed. A lost commit acknowledgement is still an unknown outcome.
      try {
        if (hash(await options.intent.recordSignedHash(operation, signed.txHash)) !== signed.txHash)
          throw originalUnknown();
      } catch { throw originalUnknown(); }
      try {
        const returned = hash(await options.rpc('eth_sendRawTransaction', [signed.raw]) as string);
        if (returned !== signed.txHash) throw originalUnknown();
        return returned;
      } catch { throw originalUnknown(); }
    },
    async findOriginal(operation) {
      checkedOperation(manifest, operation);
      await assertNetwork();
      const intended = await options.intent.readSignedHash(operation);
      if (intended === null) return null;
      hash(intended);
      const candidate = await options.lookup.findAtOriginalNonce(operation);
      const found = verifyOriginalTransaction(operation, signer, candidate);
      if (found !== null && found !== intended) throw new StocksError('SIGNER_ORIGINAL_TRANSACTION_MISMATCH', 503);
      return found;
    },
  };
}
