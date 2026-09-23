import { callDigest, canonicalJson, ensure, freezeManifest, hash, immutable, manifestDigest, StocksError,
  type AuthorizedCall, type Manifest, type Submission } from '../stocks/contracts.js';
import { canonicalStocksSignerCall } from '../stocks-runtime/signer-call.js';

export type SignerOperation = {
  operationId: string;
  deploymentDigest: string;
  callDigest: string;
  call: AuthorizedCall;
  originalNonce: string;
  txHash: string | null;
};

/**
 * A production implementation must commit the immutable operation and its
 * original nonce before any send. reserve must be atomic across processes and
 * must block new nonces while an earlier send has an unknown outcome.
 */
export type DurableSignerJournal = {
  reserve(operation: Omit<SignerOperation, 'originalNonce' | 'txHash'>): Promise<{ created: boolean; operation: SignerOperation }>;
  read(operationId: string): Promise<SignerOperation | null>;
  recordHash(operationId: string, callDigest: string, txHash: string): Promise<SignerOperation>;
};

/**
 * A future external adapter owns nonce serialization, exact signing and the
 * original-transaction lookup. Neither method may choose a replacement call.
 */
export type OriginalSignerTransport = {
  sendOnce(operation: Readonly<SignerOperation>): Promise<string>;
  findOriginal(operation: Readonly<SignerOperation>): Promise<string | null>;
};

const requestFields = ['protocol', 'deploymentDigest', 'call', 'callDigest'];
const operationIdPattern = /^(mint|refund|redeem|return):[A-Za-z0-9:_-]{1,256}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const noncePattern = /^(0|[1-9][0-9]{0,77})$/;
const unavailable = (code: string): StocksError => new StocksError(code, 503);

/** Strict, side-effect-free decoder for PUT /v1/operations/:operationId. */
export function parseStocksSignerPut(manifest: Manifest, pathId: unknown, value: unknown): Omit<SignerOperation, 'originalNonce' | 'txHash'> {
  ensure(typeof pathId === 'string' && operationIdPattern.test(pathId), 'SIGNER_OPERATION_ID_INVALID');
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'SIGNER_REQUEST_INVALID');
  const row = value as Record<string, unknown>;
  ensure(Object.keys(row).sort().join(',') === [...requestFields].sort().join(','), 'SIGNER_REQUEST_INVALID');
  ensure(row.protocol === 'ARCO_STOCKS_SIGNER_V1' && row.deploymentDigest === manifestDigest(manifest), 'SIGNER_DEPLOYMENT_MISMATCH');
  const { call, digest } = canonicalStocksSignerCall(manifest, row.call);
  ensure(call.operationId === pathId && typeof row.callDigest === 'string' && digestPattern.test(row.callDigest)
    && row.callDigest === digest, 'SIGNER_OPERATION_MISMATCH');
  return immutable({ operationId: pathId, deploymentDigest: row.deploymentDigest, callDigest: digest, call });
}

/** No listener or capabilities endpoint is created by this unconfigured core. */
export function createStocksSignerCore(options: {
  manifest: Manifest;
  journal: DurableSignerJournal;
  transport: OriginalSignerTransport;
}) {
  const manifest = freezeManifest(options.manifest);
  const deploymentDigest = manifestDigest(manifest);
  const { journal, transport } = options;

  function validateStored(value: SignerOperation, expected?: Omit<SignerOperation, 'originalNonce' | 'txHash'> | SignerOperation): SignerOperation {
    try {
      const decoded = canonicalStocksSignerCall(manifest, value.call);
      ensure(value.operationId === decoded.call.operationId && value.deploymentDigest === deploymentDigest
        && value.callDigest === decoded.digest && callDigest(value.call) === decoded.digest
        && typeof value.originalNonce === 'string' && noncePattern.test(value.originalNonce)
        && BigInt(value.originalNonce) < 2n ** 256n,
      'SIGNER_RECORD_MISMATCH', 503);
      if (expected) ensure(value.operationId === expected.operationId && value.deploymentDigest === expected.deploymentDigest
        && value.callDigest === expected.callDigest && canonicalJson(value.call) === canonicalJson(expected.call),
      'SIGNER_IMMUTABLE_OPERATION_CONFLICT', 409);
      if (expected && 'originalNonce' in expected)
        ensure(value.originalNonce === expected.originalNonce, 'SIGNER_RECORD_MISMATCH', 503);
      if (value.txHash !== null) hash(value.txHash);
      return immutable(value);
    } catch (error) {
      if (error instanceof StocksError && error.code === 'SIGNER_IMMUTABLE_OPERATION_CONFLICT') throw error;
      throw unavailable('SIGNER_RECORD_MISMATCH');
    }
  }
  function submission(operation: SignerOperation): Submission | null {
    return operation.txHash === null ? null : immutable({ operationId: operation.operationId, callDigest: operation.callDigest, txHash: hash(operation.txHash) });
  }
  async function saveHash(operation: SignerOperation, txHash: string): Promise<Submission> {
    let saved: SignerOperation;
    try { hash(txHash); saved = await journal.recordHash(operation.operationId, operation.callDigest, txHash); }
    catch { throw unavailable('SIGNER_ORIGINAL_OUTCOME_UNKNOWN'); }
    const checked = validateStored(saved, operation);
    ensure(checked.txHash === txHash, 'SIGNER_RECORD_MISMATCH', 503);
    return submission(checked)!;
  }
  return {
    parsePut: (pathId: unknown, value: unknown) => parseStocksSignerPut(manifest, pathId, value),
    async submit(pathId: unknown, value: unknown): Promise<Submission | null> {
      const requested = parseStocksSignerPut(manifest, pathId, value);
      let reserved: { created: boolean; operation: SignerOperation };
      try { reserved = await journal.reserve(requested); }
      catch { throw unavailable('SIGNER_JOURNAL_UNAVAILABLE'); }
      const operation = validateStored(reserved.operation, requested);
      if (!reserved.created) return submission(operation); // Never re-send an original operation.
      ensure(operation.txHash === null, 'SIGNER_RECORD_MISMATCH', 503);
      let txHash: string;
      try { txHash = await transport.sendOnce(operation); }
      catch { throw unavailable('SIGNER_ORIGINAL_OUTCOME_UNKNOWN'); }
      return saveHash(operation, txHash);
    },
    async lookup(operationId: unknown): Promise<Submission | null> {
      ensure(typeof operationId === 'string' && operationIdPattern.test(operationId), 'SIGNER_OPERATION_ID_INVALID');
      let loaded: SignerOperation | null;
      try { loaded = await journal.read(operationId); }
      catch { throw unavailable('SIGNER_JOURNAL_UNAVAILABLE'); }
      if (!loaded) return null;
      const operation = validateStored(loaded);
      ensure(operation.operationId === operationId, 'SIGNER_RECORD_MISMATCH', 503);
      const known = submission(operation);
      if (known) return known;
      let found: string | null;
      try { found = await transport.findOriginal(operation); }
      catch { throw unavailable('SIGNER_RECOVERY_UNAVAILABLE'); }
      return found === null ? null : saveHash(operation, found);
    },
  };
}
