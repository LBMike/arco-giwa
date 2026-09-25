import { address, freezeManifest, immutable, StocksError, type Manifest, type SqlClient, type SqlPool } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import { chainNonces } from './readiness.js';

// Operator tooling for a hosted signer's dedicated journal (the stocks_signer
// schema). The schema itself comes from ./migrations, applied explicitly. This
// module never creates schema, never discovers a nonce on its own and never
// inserts an operation: seeding writes exactly one account row whose starting
// nonce the operator reviewed and passed in, after the chain agrees with it.

const MAX_SEED_NONCE = BigInt(Number.MAX_SAFE_INTEGER);
const RELATIONS = `SELECT to_regclass('stocks_signer.account_nonce') IS NOT NULL AS account_nonce,
  to_regclass('stocks_signer.operation') IS NOT NULL AS operation,
  to_regclass('stocks_signer.signed_intent') IS NOT NULL AS signed_intent`;
const ACCOUNT = `SELECT "networkInstance", "checkpointNumber", "checkpointHash",
  "initialNonce"::text AS "initialNonce", "nextNonce"::text AS "nextNonce"
  FROM stocks_signer.account_nonce WHERE "chainId"=91342 AND "signerAddress"=$1`;

export type SignerJournalAccount = Readonly<{ initialNonce: string; nextNonce: string; matchesManifest: boolean }>;
export type SignerJournalStatus = Readonly<{
  signerAddress: string;
  chain: Readonly<{ checkpoint: string; finalized: string; pending: string; quiet: boolean }>;
  journal: Readonly<{ schema: boolean; account: SignerJournalAccount | null }>;
}>;

function reviewedNonce(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > MAX_SEED_NONCE)
    throw new StocksError('SIGNER_SEED_NONCE_INVALID', 400);
  return BigInt(value);
}

async function inTransaction<T>(pool: SqlPool, write: boolean, work: (db: SqlClient) => Promise<T>): Promise<T> {
  let db: SqlClient | undefined;
  let begun = false;
  try {
    db = await pool.connect();
    await db.query(write ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    begun = true;
    await db.query("SET LOCAL statement_timeout = '5000ms'");
    await db.query("SET LOCAL lock_timeout = '2000ms'");
    const result = await work(db);
    await db.query('COMMIT');
    begun = false;
    return result;
  } catch (error) {
    if (db && begun) { try { await db.query('ROLLBACK'); } catch { /* keep the original fixed error */ } }
    if (error instanceof StocksError) throw error;
    throw new StocksError('SIGNER_JOURNAL_UNAVAILABLE', 503);
  } finally { db?.release(); }
}

async function schemaReady(db: SqlClient): Promise<boolean> {
  const row = (await db.query(RELATIONS)).rows[0];
  return row?.account_nonce === true && row.operation === true && row.signed_intent === true;
}

function accountView(row: Record<string, unknown> | undefined, manifest: Manifest): SignerJournalAccount | null {
  if (!row) return null;
  return immutable({ initialNonce: String(row.initialNonce), nextNonce: String(row.nextNonce),
    matchesManifest: row.networkInstance === manifest.networkInstance && row.checkpointNumber === manifest.checkpointNumber
      && row.checkpointHash === manifest.checkpointHash });
}

/** Read-only view for an operator: chain nonces as the signer's readiness sees them plus the journal row. */
export async function signerJournalStatus(options: { pool: SqlPool; manifest: Manifest; rpc: JsonRpcTransport }): Promise<SignerJournalStatus> {
  const manifest = freezeManifest(options.manifest);
  const signerAddress = address(manifest.signerAddress);
  const chain = await chainNonces(manifest, options.rpc);
  const journal = await inTransaction(options.pool, false, async db => {
    if (!await schemaReady(db)) return { schema: false, account: null };
    return { schema: true, account: accountView((await db.query(ACCOUNT, [signerAddress])).rows[0], manifest) };
  });
  return immutable({ signerAddress,
    chain: { checkpoint: chain.checkpoint.toString(), finalized: chain.finalized.toString(), pending: chain.pending.toString(),
      quiet: chain.finalized === chain.pending },
    journal });
}

/**
 * Seeds the one account row at the reviewed starting nonce. The chain must be quiet
 * at exactly that nonce (finalized = pending = reviewed) so no original is in flight.
 * Re-running with the same reviewed nonce is a no-op; any other existing row is refused.
 */
export async function seedSignerJournal(options: {
  pool: SqlPool; manifest: Manifest; reviewedInitialNonce: string; rpc: JsonRpcTransport;
}): Promise<Readonly<{ status: 'SEEDED' | 'ALREADY_SEEDED'; nonce: string }>> {
  const manifest = freezeManifest(options.manifest);
  const signerAddress = address(manifest.signerAddress);
  const nonce = reviewedNonce(options.reviewedInitialNonce);
  const chain = await chainNonces(manifest, options.rpc);
  if (chain.finalized !== nonce || chain.pending !== nonce || chain.checkpoint > nonce)
    throw new StocksError('SIGNER_SEED_CHAIN_NONCE_MISMATCH', 409);
  return inTransaction(options.pool, true, async db => {
    if (!await schemaReady(db)) throw new StocksError('SIGNER_SEED_MIGRATION_MISSING', 503);
    const inserted = (await db.query(`INSERT INTO stocks_signer.account_nonce
      ("chainId", "signerAddress", "networkInstance", "checkpointNumber", "checkpointHash", "initialNonce", "nextNonce")
      VALUES (91342, $1, $2, $3, $4, $5::numeric, $5::numeric)
      ON CONFLICT ("chainId", "signerAddress") DO NOTHING RETURNING "signerAddress"`,
    [signerAddress, manifest.networkInstance, manifest.checkpointNumber, manifest.checkpointHash, nonce.toString()])).rows;
    if (inserted.length === 1) return immutable({ status: 'SEEDED' as const, nonce: nonce.toString() });
    const existing = accountView((await db.query(ACCOUNT, [signerAddress])).rows[0], manifest);
    if (existing?.matchesManifest && existing.initialNonce === nonce.toString())
      return immutable({ status: 'ALREADY_SEEDED' as const, nonce: nonce.toString() });
    throw new StocksError('SIGNER_SEED_ACCOUNT_MISMATCH', 409);
  });
}
