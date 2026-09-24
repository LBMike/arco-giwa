import { address, callDigest, canonicalJson, ensure, freezeManifest, hash, immutable, manifestDigest, StocksError,
  type AuthorizedCall, type Manifest, type SqlClient, type SqlPool } from '../stocks/contracts.js';
import { canonicalStocksSignerCall } from '../stocks-runtime/signer-call.js';
import type { DurableSignerJournal, SignerOperation } from './core.js';

const MAX_NONCE = 2n ** 256n - 1n;
const operationColumns = '"operationId","deploymentDigest","callDigest",call,"originalNonce"::text AS "originalNonce","txHash"';
const journalUnavailable = () => new StocksError('SIGNER_JOURNAL_UNAVAILABLE', 503);

function nonce(value: unknown): string {
  ensure(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= MAX_NONCE,
    'SIGNER_NONCE_INVALID');
  return value;
}

function operationRow(value: Record<string, unknown>): SignerOperation {
  ensure(typeof value.operationId === 'string' && typeof value.deploymentDigest === 'string'
    && typeof value.callDigest === 'string' && typeof value.call === 'object' && value.call !== null
    && (value.txHash === null || typeof value.txHash === 'string'), 'SIGNER_JOURNAL_INVALID', 503);
  let originalNonce: string;
  try { originalNonce = nonce(value.originalNonce); }
  catch { throw new StocksError('SIGNER_JOURNAL_INVALID', 503); }
  return immutable({
    operationId: value.operationId, deploymentDigest: value.deploymentDigest, callDigest: value.callDigest,
    call: value.call as AuthorizedCall, originalNonce, txHash: value.txHash,
  });
}

/** Explicitly seeded, dedicated signer DB. No schema creation or nonce discovery. */
export class PostgresSignerJournal implements DurableSignerJournal {
  readonly manifest: Manifest;
  readonly digest: string;
  readonly signerAddress: string;
  readonly initialNonce: string;
  constructor(readonly pool: SqlPool, manifest: Manifest, expectedInitialNonce: string) {
    this.manifest = freezeManifest(manifest);
    this.digest = manifestDigest(this.manifest);
    this.signerAddress = address(this.manifest.signerAddress);
    this.initialNonce = nonce(expectedInitialNonce);
  }

  private async transaction<T>(write: boolean, work: (db: SqlClient) => Promise<T>): Promise<T> {
    let db: SqlClient | undefined;
    let begun = false;
    try {
      db = await this.pool.connect();
      await db.query(write ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      begun = true;
      await db.query("SET LOCAL statement_timeout = '5000ms'");
      await db.query("SET LOCAL lock_timeout = '2000ms'");
      const result = await work(db);
      await db.query('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      if (db && begun) { try { await db.query('ROLLBACK'); } catch { /* preserve the original fixed error */ } }
      if (error instanceof StocksError) throw error;
      throw journalUnavailable();
    } finally { db?.release(); }
  }

  private async account(db: SqlClient, lock: boolean): Promise<string> {
    const account = (await db.query(`SELECT "networkInstance","checkpointNumber","checkpointHash",
      "initialNonce"::text AS "initialNonce","nextNonce"::text AS "nextNonce"
      FROM stocks_signer.account_nonce WHERE "chainId"=91342 AND "signerAddress"=$1${lock ? ' FOR UPDATE' : ''}`,
    [this.signerAddress])).rows[0];
    ensure(account, 'SIGNER_ACCOUNT_NOT_INITIALIZED', 503);
    ensure(account.networkInstance === this.manifest.networkInstance
      && account.checkpointNumber === this.manifest.checkpointNumber
      && account.checkpointHash === this.manifest.checkpointHash, 'SIGNER_ACCOUNT_NETWORK_MISMATCH', 503);
    ensure(nonce(account.initialNonce) === this.initialNonce, 'SIGNER_ACCOUNT_NONCE_MISMATCH', 503);
    return nonce(account.nextNonce);
  }

  private matchOperation(stored: SignerOperation, expected: Readonly<SignerOperation>): void {
    const canonical = canonicalStocksSignerCall(this.manifest, expected.call);
    ensure(expected.operationId === canonical.call.operationId && expected.deploymentDigest === this.digest
      && expected.callDigest === canonical.digest && callDigest(expected.call) === canonical.digest
      && stored.operationId === expected.operationId && stored.deploymentDigest === expected.deploymentDigest
      && stored.callDigest === expected.callDigest && stored.originalNonce === expected.originalNonce
      && canonicalJson(stored.call) === canonicalJson(expected.call), 'SIGNER_IMMUTABLE_OPERATION_CONFLICT', 409);
  }

  async reserve(input: Omit<SignerOperation, 'originalNonce' | 'txHash'>): Promise<{ created: boolean; operation: SignerOperation }> {
    const canonical = canonicalStocksSignerCall(this.manifest, input.call);
    ensure(input.operationId === canonical.call.operationId && input.deploymentDigest === this.digest
      && input.callDigest === canonical.digest && callDigest(input.call) === canonical.digest,
    'SIGNER_OPERATION_MISMATCH');
    const requested = immutable(input);
    return this.transaction(true, async db => {
      const nextNonce = await this.account(db, true); // physical signer serialization across processes
      const existing = (await db.query(`SELECT ${operationColumns},"chainId","signerAddress"
        FROM stocks_signer.operation WHERE "operationId"=$1 FOR UPDATE`,
        [requested.operationId])).rows[0];
      if (existing) {
        const stored = operationRow(existing);
        ensure(existing.chainId === 91342 && existing.signerAddress === this.signerAddress
          && stored.deploymentDigest === requested.deploymentDigest && stored.callDigest === requested.callDigest
          && canonicalJson(stored.call) === canonicalJson(requested.call), 'SIGNER_IMMUTABLE_OPERATION_CONFLICT', 409);
        return { created: false, operation: stored };
      }
      const unresolved = (await db.query(`SELECT 1 FROM stocks_signer.operation
        WHERE "chainId"=91342 AND "signerAddress"=$1 AND "txHash" IS NULL LIMIT 1`, [this.signerAddress])).rows[0];
      ensure(!unresolved, 'SIGNER_ORIGINAL_OUTCOME_UNKNOWN', 503);
      ensure(BigInt(nextNonce) < MAX_NONCE, 'SIGNER_NONCE_EXHAUSTED', 503);
      const inserted = (await db.query(`INSERT INTO stocks_signer.operation
        ("operationId","chainId","signerAddress","deploymentDigest","callDigest",call,"originalNonce")
        VALUES ($1,91342,$2,$3,$4,$5::jsonb,$6::numeric) RETURNING ${operationColumns}`,
      [requested.operationId, this.signerAddress, requested.deploymentDigest, requested.callDigest,
        JSON.stringify(requested.call), nextNonce])).rows[0];
      const updated = await db.query(`UPDATE stocks_signer.account_nonce SET "nextNonce"="nextNonce"+1
        WHERE "chainId"=91342 AND "signerAddress"=$1 AND "nextNonce"=$2::numeric`, [this.signerAddress, nextNonce]);
      ensure(updated.rowCount === 1, 'SIGNER_NONCE_RACE', 503);
      return { created: true, operation: operationRow(inserted) };
    });
  }

  async read(operationId: string): Promise<SignerOperation | null> {
    return this.transaction(false, async db => {
      await this.account(db, false);
      const found = (await db.query(`SELECT ${operationColumns} FROM stocks_signer.operation
        WHERE "operationId"=$1 AND "chainId"=91342 AND "signerAddress"=$2`,
      [operationId, this.signerAddress])).rows[0];
      return found ? operationRow(found) : null;
    });
  }

  /** Commit the verified signed bytes' hash before the first RPC broadcast. */
  async recordSignedHash(operation: Readonly<SignerOperation>, signedHash: string): Promise<string> {
    hash(signedHash);
    return this.transaction(true, async db => {
      await this.account(db, true);
      const found = (await db.query(`SELECT ${operationColumns} FROM stocks_signer.operation
        WHERE "operationId"=$1 AND "chainId"=91342 AND "signerAddress"=$2 FOR UPDATE`,
      [operation.operationId, this.signerAddress])).rows[0];
      ensure(found, 'SIGNER_OPERATION_UNKNOWN', 404);
      const stored = operationRow(found);
      this.matchOperation(stored, operation);
      const existing = (await db.query(`SELECT "signedHash" FROM stocks_signer.signed_intent
        WHERE "operationId"=$1 FOR UPDATE`, [operation.operationId])).rows[0];
      if (existing) {
        ensure(existing.signedHash === signedHash, 'SIGNER_SIGNED_HASH_CONFLICT', 409);
        return existing.signedHash as string;
      }
      ensure(stored.txHash === null, 'SIGNER_SIGNED_HASH_CONFLICT', 409);
      await db.query(`INSERT INTO stocks_signer.signed_intent ("operationId","signedHash") VALUES ($1,$2)`,
        [operation.operationId, signedHash]);
      return signedHash;
    });
  }

  /** Read only the immutable hash already committed for this exact operation. */
  async readSignedHash(operation: Readonly<SignerOperation>): Promise<string | null> {
    return this.transaction(false, async db => {
      await this.account(db, false);
      const found = (await db.query(`SELECT ${operationColumns} FROM stocks_signer.operation
        WHERE "operationId"=$1 AND "chainId"=91342 AND "signerAddress"=$2`,
      [operation.operationId, this.signerAddress])).rows[0];
      ensure(found, 'SIGNER_OPERATION_UNKNOWN', 404);
      this.matchOperation(operationRow(found), operation);
      const intent = (await db.query(`SELECT "signedHash" FROM stocks_signer.signed_intent
        WHERE "operationId"=$1`, [operation.operationId])).rows[0];
      return intent ? hash(intent.signedHash) : null;
    });
  }

  async recordHash(operationId: string, expectedDigest: string, txHash: string): Promise<SignerOperation> {
    hash(txHash);
    return this.transaction(true, async db => {
      await this.account(db, true); // same lock order as reserve
      const found = (await db.query(`SELECT ${operationColumns} FROM stocks_signer.operation
        WHERE "operationId"=$1 AND "chainId"=91342 AND "signerAddress"=$2 FOR UPDATE`,
      [operationId, this.signerAddress])).rows[0];
      ensure(found, 'SIGNER_OPERATION_UNKNOWN', 404);
      const stored = operationRow(found);
      ensure(stored.deploymentDigest === this.digest && stored.callDigest === expectedDigest, 'SIGNER_IMMUTABLE_OPERATION_CONFLICT', 409);
      const intent = (await db.query(`SELECT "signedHash" FROM stocks_signer.signed_intent
        WHERE "operationId"=$1`, [operationId])).rows[0];
      ensure(intent, 'SIGNER_SIGNED_INTENT_REQUIRED', 503);
      ensure(intent.signedHash === txHash, 'SIGNER_SIGNED_INTENT_MISMATCH', 409);
      if (stored.txHash !== null) {
        ensure(stored.txHash === txHash, 'SIGNER_HASH_CONFLICT', 409);
        return stored;
      }
      const updated = (await db.query(`UPDATE stocks_signer.operation SET "txHash"=$3,"hashRecordedAt"=clock_timestamp()
        WHERE "operationId"=$1 AND "callDigest"=$2 AND "txHash" IS NULL RETURNING ${operationColumns}`,
      [operationId, expectedDigest, txHash])).rows[0];
      ensure(updated, 'SIGNER_HASH_CONFLICT', 409);
      return operationRow(updated);
    });
  }
}
