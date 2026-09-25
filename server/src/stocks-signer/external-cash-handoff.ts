import { createHash } from 'node:crypto';
import { getContractAddress, keccak256, type Hex } from 'viem';
import { address, canonicalJson, ensure, freezeManifest, hash, immutable, manifestDigest,
  type Manifest, type SqlPool } from '../stocks/contracts.js';
import type { JsonRpcTransport } from '../stocks/rpc.js';

export const TUSDC_JOURNAL_DATABASE = 'arco_signer_tusdc_025';
const contractOrder = ['fundingVault', 'mintController', 'stockToken', 'redemptionEscrow'] as const;
type Creation = { contract: typeof contractOrder[number]; nonce: string; inputHash: Hex; transactionHash: Hex };
export type ExternalCashHandoffPlan = {
  schemaVersion: 1; purpose: 'GIWA_TUSDC_SIGNER_HANDOFF_025'; priorManifest: Manifest; manifest: Manifest;
  reviewedPriorManifestDigest: string; reviewedManifestDigest: string;
  reviewedPriorInitialNonce: string; reviewedFirstCreateNonce: string; creations: Creation[];
};
const fail = () => Error('TUSDC_HANDOFF_VERIFICATION_REQUIRED');
function exact(value: unknown, keys: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) throw fail();
  return value as Record<string, any>;
}
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)
    || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw fail();
  return BigInt(value);
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw fail();
  return BigInt(value);
}
async function requireCanonicalNonceSnapshot(rpc: JsonRpcTransport, signer: string, expected: bigint, finalizedTag: string): Promise<void> {
  // Signer transport deliberately rejects transaction-count('latest'). Resolve
  // the head once, use its explicit number, then check that number is canonical.
  const latest = await rpc('eth_getBlockByNumber', ['latest', false]) as Record<string, any>;
  if (quantity(latest?.number) < quantity(finalizedTag)) throw fail();
  hash(latest?.hash);
  for (const tag of [finalizedTag, latest.number, 'pending']) {
    if (quantity(await rpc('eth_getTransactionCount', [signer, tag])) !== expected) throw fail();
  }
  const canonical = await rpc('eth_getBlockByNumber', [latest.number, false]) as Record<string, any>;
  if (canonical?.number !== latest.number || canonical?.hash !== latest.hash) throw fail();
}
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function parseExternalCashHandoffPlan(value: unknown, reviewed: { priorManifestDigest: string; manifestDigest: string }): Readonly<ExternalCashHandoffPlan> {
  try {
    const p = exact(value, 'schemaVersion,purpose,priorManifest,manifest,reviewedPriorManifestDigest,reviewedManifestDigest,reviewedPriorInitialNonce,reviewedFirstCreateNonce,creations');
    const manifestKeys = 'schemaVersion,redemptionEscrow,deploymentId,profile,chainId,networkInstance,checkpointNumber,checkpointHash,abiDigest,finalityPolicy,cashToken,cashSymbol,cashScale,stockToken,quantityScale,fundingVault,mintController,signerAddress,codeHashes,restrictedTransfers,nonUpgradeable';
    exact(p.priorManifest, manifestKeys);
    exact(p.manifest, manifestKeys + ',stockContractsNonUpgradeable,cashIdentity');
    const old = freezeManifest(p.priorManifest), next = freezeManifest(p.manifest);
    if (p.schemaVersion !== 1 || p.purpose !== 'GIWA_TUSDC_SIGNER_HANDOFF_025'
      || old.schemaVersion !== 2 || next.schemaVersion !== 3
      || manifestDigest(old) !== reviewed.priorManifestDigest || manifestDigest(next) !== reviewed.manifestDigest
      || p.reviewedPriorManifestDigest !== reviewed.priorManifestDigest || p.reviewedManifestDigest !== reviewed.manifestDigest
      || address(old.signerAddress) !== address(next.signerAddress)
      || reviewed.priorManifestDigest === reviewed.manifestDigest
      || BigInt(next.checkpointNumber) < BigInt(old.checkpointNumber)
      || decimal(p.reviewedPriorInitialNonce) > decimal(p.reviewedFirstCreateNonce)
      || decimal(p.reviewedFirstCreateNonce) + 4n > BigInt(Number.MAX_SAFE_INTEGER)
      || !Array.isArray(p.creations) || p.creations.length !== 4) throw fail();
    const hashes = new Set<string>();
    for (const [i, value] of p.creations.entries()) {
      const c = exact(value, 'contract,nonce,inputHash,transactionHash');
      if (c.contract !== contractOrder[i] || decimal(c.nonce) !== decimal(p.reviewedFirstCreateNonce) + BigInt(i)) throw fail();
      hash(c.inputHash); hash(c.transactionHash);
      if (hashes.has(c.transactionHash) || address(getContractAddress({ from: next.signerAddress, nonce: decimal(c.nonce) })) !== address(next[contractOrder[i]!])) throw fail();
      hashes.add(c.transactionHash);
      if ([old.fundingVault, old.mintController, old.stockToken, old.redemptionEscrow].some(a => address(a) === address(next[contractOrder[i]!]))) throw fail();
    }
    return immutable({ ...p, priorManifest: old, manifest: next }) as Readonly<ExternalCashHandoffPlan>;
  } catch { throw fail(); }
}

/** Read-only: old trading must remain paused, and no customer records may vanish at this cutover.
 * This initial handoff intentionally supports an unused Stocks deployment only. A deployment
 * with any customer order/holding needs a separate historical read/recovery migration. */
export async function requireEmptyPriorStocksEpoch(pool: SqlPool, priorDigest: string): Promise<void> {
  const result = await pool.query(`SELECT
    (SELECT paused FROM arco_evm."StocksTradingControl" WHERE "deploymentDigest"=$1) AS paused,
    (SELECT COUNT(*) FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$1)::text AS orders,
    (SELECT COUNT(*) FROM arco_evm."StocksSellOrder" WHERE "deploymentDigest"=$1)::text AS sells,
    (SELECT COUNT(*) FROM arco_evm."StocksHolding" WHERE "deploymentDigest"=$1)::text AS holdings,
    (SELECT COUNT(*) FROM arco_evm."StocksFunding" WHERE "deploymentDigest"=$1)::text AS funding,
    (SELECT COUNT(*) FROM arco_evm."StocksOutbox" WHERE "deploymentDigest"=$1)::text AS outbox,
    (SELECT COUNT(*) FROM arco_evm."StocksWalletSubmission" WHERE "deploymentDigest"=$1)::text AS submissions`, [priorDigest]);
  const row = result.rows[0];
  ensure(row?.paused === true && ['orders', 'sells', 'holdings', 'funding', 'outbox', 'submissions'].every(k => row[k] === '0'),
    'TUSDC_PRIOR_EPOCH_NOT_EMPTY_OR_PAUSED', 503);
}

export type ExternalCashHandoffEvidence = Readonly<{
  schemaVersion: 1; planDigest: string; priorManifestDigest: string; manifestDigest: string;
  priorInitialNonce: string; priorNextNonce: string; initialNonce: string;
  finalizedBlock: string; finalizedHash: Hex; oldJournalDigest: string;
}>;

/** Run under the shared 4396 lock, after the audited operator pause and before
 * the first CREATE is signed. Current scope requires an unused Stocks epoch. */
export async function verifyExternalCashPredeployment(options: {
  priorManifest: Manifest; reviewedPriorManifestDigest: string; firstCreateNonce: string;
  priorJournal: SqlPool; rpc: JsonRpcTransport; requirePriorEpoch: () => Promise<void>;
}): Promise<{ priorInitialNonce: string; firstCreateNonce: string }> {
  try {
    const { priorManifest: m, rpc } = options, signer = address(m.signerAddress), n = decimal(options.firstCreateNonce);
    if (m.schemaVersion !== 2 || manifestDigest(freezeManifest(m)) !== options.reviewedPriorManifestDigest) throw fail();
    await options.requirePriorEpoch();
    const account = (await options.priorJournal.query(`SELECT "networkInstance","checkpointNumber","checkpointHash",
      "initialNonce"::text AS "initialNonce","nextNonce"::text AS "nextNonce"
      FROM stocks_signer.account_nonce WHERE "chainId"=91342 AND "signerAddress"=$1`, [signer])).rows[0];
    const operations = (await options.priorJournal.query('SELECT COUNT(*)::text AS count FROM stocks_signer.operation WHERE "chainId"=91342 AND "signerAddress"=$1', [signer])).rows[0];
    if (!account || account.networkInstance !== m.networkInstance || account.checkpointNumber !== m.checkpointNumber
      || account.checkpointHash !== m.checkpointHash || account.nextNonce !== options.firstCreateNonce
      || account.initialNonce !== account.nextNonce || operations?.count !== '0') throw fail();
    if (await rpc('eth_chainId', []) !== '0x164ce') throw fail();
    const checkpoint = await rpc('eth_getBlockByNumber', [`0x${BigInt(m.checkpointNumber).toString(16)}`, false]) as Record<string, any>;
    const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]) as Record<string, any>;
    if (checkpoint?.hash !== m.checkpointHash || quantity(checkpoint?.number) !== BigInt(m.checkpointNumber)
      || quantity(finalized?.number) < BigInt(m.checkpointNumber)) throw fail();
    hash(finalized.hash);
    await requireCanonicalNonceSnapshot(rpc, signer, n, finalized.number);
    for (const [to, data] of [[m.stockToken, '0x18160ddd'], [m.cashToken, `0x70a08231${address(m.fundingVault).slice(2).padStart(64, '0')}`]]) {
      const answer = await rpc('eth_call', [{ to, data }, finalized.number]);
      if (typeof answer !== 'string' || !/^0x0{64}$/.test(answer)) throw fail();
    }
    const again = await rpc('eth_getBlockByNumber', [finalized.number, false]) as Record<string, any>;
    if (again?.hash !== finalized.hash || await rpc('eth_chainId', []) !== '0x164ce') throw fail();
    await options.requirePriorEpoch();
    return { priorInitialNonce: account.initialNonce, firstCreateNonce: options.firstCreateNonce };
  } catch { throw fail(); }
}

/** A new physical database reuses the reviewed guards verbatim; no trigger migration. */
export async function requireIsolatedJournalSchemas(prior: SqlPool, next: SqlPool): Promise<void> {
  const query = `SELECT 'column' AS kind, c.table_name || '.' || c.column_name AS name, (to_jsonb(c)-'table_catalog'-'udt_catalog'-'domain_catalog'-'scope_catalog')::text AS definition
    FROM information_schema.columns c WHERE c.table_schema='stocks_signer'
    UNION ALL SELECT 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='stocks_signer'
    UNION ALL SELECT 'trigger', c.relname || '.' || t.tgname, t.tgenabled::text || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='stocks_signer' AND NOT t.tgisinternal
    UNION ALL SELECT 'function', p.proname, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='stocks_signer' ORDER BY kind,name`;
  const old = (await prior.query(query)).rows, current = (await next.query(query)).rows;
  ensure(old.length > 0 && digest(old) === digest(current), 'TUSDC_JOURNAL_SCHEMA_MISMATCH', 503);
}

/** Fresh, canonical reads only. This function neither advances nor reseeds either journal.
 * The caller must hold the process-wide 4396 lock and keep the old API/signer stopped. */
export async function verifyExternalCashHandoff(options: {
  plan: Readonly<ExternalCashHandoffPlan>; priorJournal: SqlPool; rpc: JsonRpcTransport;
  requirePriorEpoch: () => Promise<void>;
}): Promise<ExternalCashHandoffEvidence> {
  const { plan: p, rpc } = options;
  const signer = address(p.manifest.signerAddress), finalNonce = decimal(p.reviewedFirstCreateNonce) + 4n;
  await options.requirePriorEpoch();
  const db = await options.priorJournal.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const account = (await db.query(`SELECT "networkInstance","checkpointNumber","checkpointHash",
      "initialNonce"::text AS "initialNonce","nextNonce"::text AS "nextNonce"
      FROM stocks_signer.account_nonce WHERE "chainId"=91342 AND "signerAddress"=$1`, [signer])).rows[0];
    if (!account || account.networkInstance !== p.priorManifest.networkInstance
      || account.checkpointNumber !== p.priorManifest.checkpointNumber || account.checkpointHash !== p.priorManifest.checkpointHash
      || account.initialNonce !== p.reviewedPriorInitialNonce || account.nextNonce !== p.reviewedFirstCreateNonce) throw fail();
    const operations = (await db.query(`SELECT o."operationId",o."deploymentDigest",o."originalNonce"::text AS "originalNonce",
      o."txHash",o.call,i."signedHash" FROM stocks_signer.operation o LEFT JOIN stocks_signer.signed_intent i USING ("operationId")
      WHERE o."chainId"=91342 AND o."signerAddress"=$1 ORDER BY o."originalNonce"`, [signer])).rows;
    if (BigInt(operations.length) !== decimal(account.nextNonce) - decimal(account.initialNonce)) throw fail();
    const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]) as Record<string, any>;
    const finalBlock = quantity(finalized?.number); hash(finalized?.hash);
    if (await rpc('eth_chainId', []) !== '0x164ce') throw fail();
    for (const m of [p.priorManifest, p.manifest]) {
      const checkpoint = await rpc('eth_getBlockByNumber', [`0x${BigInt(m.checkpointNumber).toString(16)}`, false]) as Record<string, any>;
      if (quantity(checkpoint?.number) !== BigInt(m.checkpointNumber) || checkpoint?.hash !== m.checkpointHash || finalBlock < BigInt(m.checkpointNumber)) throw fail();
    }
    const confirmed = async (txHash: Hex) => {
      const tx = await rpc('eth_getTransactionByHash', [txHash]) as Record<string, any>;
      const r = await rpc('eth_getTransactionReceipt', [txHash]) as Record<string, any>;
      if (!tx || !r || tx.hash !== txHash || r.transactionHash !== txHash || r.status !== '0x1'
        || address(tx.from) !== signer || address(r.from) !== signer || quantity(tx.value) !== 0n
        || tx.blockHash !== r.blockHash || tx.blockNumber !== r.blockNumber || quantity(r.blockNumber) > finalBlock) throw fail();
      const block = await rpc('eth_getBlockByNumber', [r.blockNumber, false]) as Record<string, any>;
      if (block?.hash !== r.blockHash || block?.number !== r.blockNumber) throw fail();
      return { tx, r };
    };
    for (const [i, op] of operations.entries()) {
      if (op.deploymentDigest !== p.reviewedPriorManifestDigest || op.txHash === null || op.signedHash !== op.txHash
        || decimal(op.originalNonce) !== decimal(account.initialNonce) + BigInt(i)) throw fail();
      const { tx } = await confirmed(hash(op.txHash));
      if (quantity(tx.nonce) !== decimal(op.originalNonce) || address(tx.to) !== address(op.call.to)
        || tx.input !== op.call.data || address(op.call.from) !== signer) throw fail();
    }
    for (const c of p.creations) {
      const { tx, r } = await confirmed(c.transactionHash);
      if (tx.to !== null || r.to !== null || address(r.contractAddress) !== address(p.manifest[c.contract])
        || quantity(tx.nonce) !== decimal(c.nonce) || typeof tx.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(tx.input)
        || keccak256(tx.input as Hex) !== c.inputHash) throw fail();
      const code = await rpc('eth_getCode', [p.manifest[c.contract], finalized.number]);
      if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)
        || keccak256(code as Hex) !== p.manifest.codeHashes[address(p.manifest[c.contract])]) throw fail();
    }
    // Database emptiness alone cannot exclude unprojected or unsolicited holdings.
    const word = (value: unknown) => {
      if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw fail();
      return BigInt(value);
    };
    const balanceData = `0x70a08231${address(p.priorManifest.fundingVault).slice(2).padStart(64, '0')}`;
    if (word(await rpc('eth_call', [{ to: p.priorManifest.stockToken, data: '0x18160ddd' }, finalized.number])) !== 0n
      || word(await rpc('eth_call', [{ to: p.priorManifest.cashToken, data: balanceData }, finalized.number])) !== 0n) throw fail();
    await requireCanonicalNonceSnapshot(rpc, signer, finalNonce, finalized.number);
    const stillFinalized = await rpc('eth_getBlockByNumber', [finalized.number, false]) as Record<string, any>;
    if (stillFinalized?.hash !== finalized.hash || await rpc('eth_chainId', []) !== '0x164ce') throw fail();
    await options.requirePriorEpoch();
    await db.query('COMMIT');
    return immutable({ schemaVersion: 1, planDigest: digest(p), priorManifestDigest: p.reviewedPriorManifestDigest,
      manifestDigest: p.reviewedManifestDigest, priorInitialNonce: account.initialNonce, priorNextNonce: account.nextNonce,
      initialNonce: finalNonce.toString(), finalizedBlock: finalBlock.toString(), finalizedHash: hash(finalized.hash),
      oldJournalDigest: digest({ account, operations }) });
  } catch { await db.query('ROLLBACK').catch(() => {}); throw fail(); }
  finally { db.release(); }
}

/** Explicit preparation only, targeting a different database. Existing rows are never reseeded.
 * Idempotency accepts only the same untouched seed; live reservations make re-preparation fail. */
export async function seedExternalCashJournal(options: {
  plan: Readonly<ExternalCashHandoffPlan>; evidence: ExternalCashHandoffEvidence;
  priorJournal: SqlPool; journal: SqlPool;
}): Promise<void> {
  const { plan: p, evidence: e, priorJournal, journal } = options;
  const identity = async (pool: SqlPool) => (await pool.query('SELECT current_database() AS database, system_identifier::text AS system FROM pg_control_system()')).rows[0];
  const old = await identity(priorJournal), next = await identity(journal);
  ensure(old && next && old.database !== next.database && old.system === next.system
    && next.database === TUSDC_JOURNAL_DATABASE, 'TUSDC_JOURNAL_ISOLATION_REQUIRED', 503);
  await requireIsolatedJournalSchemas(priorJournal, journal);
  ensure(e.planDigest === digest(p) && e.manifestDigest === p.reviewedManifestDigest
    && e.priorManifestDigest === p.reviewedPriorManifestDigest && e.initialNonce === (decimal(p.reviewedFirstCreateNonce) + 4n).toString(), 'TUSDC_HANDOFF_EVIDENCE_MISMATCH', 503);
  const db = await journal.connect();
  try {
    await db.query('BEGIN');
    await db.query('LOCK TABLE stocks_signer.account_nonce IN SHARE ROW EXCLUSIVE MODE');
    const operations = (await db.query('SELECT COUNT(*)::text AS count FROM stocks_signer.operation')).rows[0];
    ensure(operations?.count === '0', 'TUSDC_JOURNAL_ALREADY_ACTIVE', 503);
    const rows = (await db.query('SELECT * FROM stocks_signer.account_nonce')).rows;
    const m = p.manifest;
    if (rows.length) {
      const row = rows[0];
      ensure(rows.length === 1 && row.chainId === 91342 && row.signerAddress === address(m.signerAddress)
        && row.networkInstance === m.networkInstance && row.checkpointNumber === m.checkpointNumber && row.checkpointHash === m.checkpointHash
        && String(row.initialNonce) === e.initialNonce && String(row.nextNonce) === e.initialNonce, 'TUSDC_JOURNAL_SEED_CONFLICT', 503);
    } else {
      await db.query(`INSERT INTO stocks_signer.account_nonce
        ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce")
        VALUES (91342,$1,$2,$3,$4,$5::numeric,$5::numeric)`, [address(m.signerAddress), m.networkInstance, m.checkpointNumber, m.checkpointHash, e.initialNonce]);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}
