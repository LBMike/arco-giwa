import { address, freezeManifest, hash, manifestDigest, type Manifest, type SqlClient } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';
import type { PostgresSignerJournal } from './postgres-journal.js';

const MAX_NONCE = 2n ** 256n - 1n;
const DEFAULT_DEADLINE_MS = 8_000;
const requiredTriggers = new Map([
  ['account_nonce', new Set(['account_nonce_guard', 'account_nonce_no_truncate'])],
  ['operation', new Set(['operation_guard', 'operation_no_truncate', 'operation_signed_intent_guard'])],
  ['signed_intent', new Set(['signed_intent_guard', 'signed_intent_no_truncate'])],
]);

export type StocksSignerReadinessOptions = {
  manifest: Manifest;
  /** Separately reviewed digest and starting nonce; neither is discovered by this probe. */
  reviewedManifestDigest: string;
  reviewedInitialNonce: string;
  journal: PostgresSignerJournal;
  /** Signer-only RPC. This probe never calls eth_sendRawTransaction. */
  rpc: JsonRpcTransport;
  /** Injected custody, provider and operator policy gate; only literal true passes. */
  operationalReady: () => Promise<boolean>;
  deadlineMs?: number;
};

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value)) throw Error('SIGNER_READINESS_INVALID');
  return BigInt(value);
}

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw Error('SIGNER_READINESS_INVALID');
  const parsed = BigInt(value);
  if (parsed > MAX_NONCE) throw Error('SIGNER_READINESS_INVALID');
  return parsed;
}

function block(value: unknown, expectedNumber?: bigint): bigint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('SIGNER_READINESS_INVALID');
  const row = value as Record<string, unknown>;
  const number = quantity(row.number);
  hash(row.hash as string);
  if (expectedNumber !== undefined && number !== expectedNumber) throw Error('SIGNER_READINESS_INVALID');
  return number;
}

async function chainNonces(manifest: Manifest, rpc: JsonRpcTransport): Promise<{ checkpoint: bigint; finalized: bigint; pending: bigint }> {
  const checkpointNumber = BigInt(manifest.checkpointNumber);
  const checkpointTag = `0x${checkpointNumber.toString(16)}`;
  if (await rpc('eth_chainId', []) !== '0x164ce') throw Error('SIGNER_READINESS_NETWORK_MISMATCH');
  const checkpointBlock = await rpc('eth_getBlockByNumber', [checkpointTag, false]);
  block(checkpointBlock, checkpointNumber);
  if ((checkpointBlock as Record<string, unknown>).hash !== manifest.checkpointHash)
    throw Error('SIGNER_READINESS_CHECKPOINT_MISMATCH');
  const finalizedBlock = await rpc('eth_getBlockByNumber', ['finalized', false]);
  const finalizedNumber = block(finalizedBlock);
  if (finalizedNumber < checkpointNumber) throw Error('SIGNER_READINESS_FINALITY_MISMATCH');
  const finalizedHash = (finalizedBlock as Record<string, unknown>).hash;
  const finalizedTag = `0x${finalizedNumber.toString(16)}`;
  const signer = address(manifest.signerAddress);
  const checkpoint = quantity(await rpc('eth_getTransactionCount', [signer, checkpointTag]));
  const finalized = quantity(await rpc('eth_getTransactionCount', [signer, finalizedTag]));
  if (finalized < checkpoint) throw Error('SIGNER_READINESS_NONCE_MISMATCH');
  const sameFinalizedBlock = await rpc('eth_getBlockByNumber', [finalizedTag, false]);
  block(sameFinalizedBlock, finalizedNumber);
  if ((sameFinalizedBlock as Record<string, unknown>).hash !== finalizedHash)
    throw Error('SIGNER_READINESS_FINALITY_MISMATCH');
  // Pending is only this provider's mempool view. It detects a visible foreign
  // nonce claim, but cannot prove no transaction is hidden at another provider;
  // the injected operational gate must require exclusive external custody.
  const pending = quantity(await rpc('eth_getTransactionCount', [signer, 'pending']));
  if (pending < finalized) throw Error('SIGNER_READINESS_NONCE_MISMATCH');
  if (await rpc('eth_chainId', []) !== '0x164ce') throw Error('SIGNER_READINESS_NETWORK_MISMATCH');
  const sameCheckpoint = await rpc('eth_getBlockByNumber', [checkpointTag, false]);
  block(sameCheckpoint, checkpointNumber);
  if ((sameCheckpoint as Record<string, unknown>).hash !== manifest.checkpointHash)
    throw Error('SIGNER_READINESS_CHECKPOINT_MISMATCH');
  return { checkpoint, finalized, pending };
}

async function databaseNonce(options: StocksSignerReadinessOptions, manifest: Manifest): Promise<bigint> {
  let db: SqlClient | undefined;
  let begun = false;
  try {
    db = await options.journal.pool.connect();
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    begun = true;
    await db.query("SET LOCAL statement_timeout = '5000ms'");
    await db.query("SET LOCAL lock_timeout = '2000ms'");
    const session = (await db.query("SELECT current_setting('session_replication_role') AS replication_role")).rows[0];
    if (session?.replication_role !== 'origin') throw Error('SIGNER_READINESS_GUARD_DISABLED');
    const relations = (await db.query(`SELECT
      to_regclass('stocks_signer.account_nonce') IS NOT NULL AS account_nonce,
      to_regclass('stocks_signer.operation') IS NOT NULL AS operation,
      to_regclass('stocks_signer.signed_intent') IS NOT NULL AS signed_intent`)).rows[0];
    if (!relations || relations.account_nonce !== true || relations.operation !== true
      || relations.signed_intent !== true) throw Error('SIGNER_READINESS_MIGRATION_MISSING');
    const triggers = (await db.query(`SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled AS enabled
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'stocks_signer'
        AND c.relname IN ('account_nonce', 'operation', 'signed_intent') AND NOT t.tgisinternal`)).rows;
    for (const [table, names] of requiredTriggers) {
      for (const name of names) {
        if (!triggers.some(row => row.table_name === table && row.trigger_name === name
          && (row.enabled === 'O' || row.enabled === 'A'))) throw Error('SIGNER_READINESS_GUARD_MISSING');
      }
    }
    const account = (await db.query(`SELECT "chainId", "signerAddress", "networkInstance", "checkpointNumber",
      "checkpointHash", "initialNonce"::text AS "initialNonce", "nextNonce"::text AS "nextNonce"
      FROM stocks_signer.account_nonce WHERE "chainId"=91342 AND "signerAddress"=$1`,
    [address(manifest.signerAddress)])).rows[0];
    if (!account || account.chainId !== 91342 || account.signerAddress !== address(manifest.signerAddress)
      || account.networkInstance !== manifest.networkInstance || account.checkpointNumber !== manifest.checkpointNumber
      || account.checkpointHash !== manifest.checkpointHash
      || decimal(account.initialNonce) !== decimal(options.reviewedInitialNonce))
      throw Error('SIGNER_READINESS_ACCOUNT_MISMATCH');
    const next = decimal(account.nextNonce);
    if (next < decimal(account.initialNonce) || next >= MAX_NONCE) throw Error('SIGNER_READINESS_NONCE_MISMATCH');
    // 0002 requires this invariant for every completed operation. Catch an
    // incomplete migration or disabled guard without mutating the journal.
    const broken = (await db.query(`SELECT 1 FROM stocks_signer.operation o
      LEFT JOIN stocks_signer.signed_intent i ON i."operationId"=o."operationId"
      WHERE o."chainId"=91342 AND o."signerAddress"=$1 AND o."txHash" IS NOT NULL
        AND (i."signedHash" IS NULL OR i."signedHash"<>o."txHash") LIMIT 1`,
    [address(manifest.signerAddress)])).rows[0];
    if (broken) throw Error('SIGNER_READINESS_SIGNED_INTENT_MISMATCH');
    await db.query('COMMIT');
    begun = false;
    return next;
  } catch (error) {
    if (db && begun) { try { await db.query('ROLLBACK'); } catch { /* fixed boolean result below */ } }
    throw error;
  } finally { db?.release(); }
}

function withinDeadline(promise: Promise<boolean>, deadlineMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), deadlineMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * Read-only, inactive readiness gate for createStocksSignerHttpService.ready.
 * It cannot prove custody or activate a listener. Any unknown, timeout or
 * malformed response returns false, so authenticated routes remain 503.
 */
export function createStocksSignerReadiness(options: StocksSignerReadinessOptions): () => Promise<boolean> {
  const manifest = freezeManifest(options.manifest);
  const digest = manifestDigest(manifest);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const configured = options.reviewedManifestDigest === digest
    && typeof options.journal?.pool?.connect === 'function'
    && options.journal.digest === digest
    && options.journal.initialNonce === options.reviewedInitialNonce
    && typeof options.rpc === 'function' && typeof options.operationalReady === 'function'
    && Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 30_000;
  let active: Promise<boolean> | null = null;
  let timedActive: Promise<boolean> | null = null;
  return async () => {
    if (!configured) return false;
    if (!active) {
      const work = (async () => {
        try {
          const chain = await chainNonces(manifest, options.rpc);
          const next = await databaseNonce(options, manifest);
          const initial = decimal(options.reviewedInitialNonce);
          if (chain.checkpoint > initial || chain.finalized < initial || chain.finalized > next
            || chain.pending > next) return false;
          return await options.operationalReady() === true;
        } catch { return false; }
      })();
      const current = work.finally(() => {
        if (active === current) { active = null; timedActive = null; }
      });
      active = current;
      timedActive = withinDeadline(current, deadlineMs);
    }
    return timedActive!;
  };
}
