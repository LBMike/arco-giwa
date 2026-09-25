import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { canonicalJson, manifestDigest } from '../../server/dist/stocks/contracts.js';
import { LOCAL_CUSTOMER_MANIFEST, LOCAL_CUSTOMER_TUSDC_MANIFEST } from '../../server/dist/stocks-runtime/local-customer.js';
import { parseExternalCashHandoffPlan, requireEmptyPriorStocksEpoch, requireIsolatedJournalSchemas, TUSDC_JOURNAL_DATABASE } from '../../server/dist/stocks-signer/external-cash-handoff.js';

export const handoffNames = Object.freeze({ plan: 'tusdc-handoff.json', evidence: 'tusdc-handoff-evidence.json' });
export const deploymentReservationName = 'tusdc-deployment-started.json';
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = () => Error('LOCAL_TUSDC_HANDOFF_NOT_PREPARED');
/** Reservation is installed before the first CREATE can be signed. Presence
 * retires the old runner even during an interrupted partial deployment. */
export async function requireLegacyLocalEpoch(base, stat = lstat) {
  for (const path of [join(base, handoffNames.plan), join(base, 'private', deploymentReservationName)]) {
    let exists = false;
    try { await stat(path); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw fail(); }
    if (exists) throw Error('LOCAL_PRIOR_EPOCH_RETIRED');
  }
}
export function tusdcJournalConnection(connection) {
  const url = new URL(connection);
  if (url.pathname !== '/arco_signer_journal' || url.hostname !== 'localhost'
    || url.username !== 'arco_signer' || url.password || url.hash
    || [...url.searchParams.keys()].join(',') !== 'host' || !url.searchParams.get('host')?.startsWith('/')) throw fail();
  url.pathname = `/${TUSDC_JOURNAL_DATABASE}`;
  return url.toString();
}

/** Installed public artifacts are additionally pinned by the launcher's reviewed-files hash.
 * This check makes no schema, journal or product-state changes and never opens a keystore. */
export async function readTusdcRunnerHandoff({ base, runtimeManifest, priorJournal, journal, productPool,
  readPublic = readStocksPublicJson, reviewedManifestDigest = LOCAL_CUSTOMER_TUSDC_MANIFEST }) {
  if (!reviewedManifestDigest || runtimeManifest.schemaVersion !== 3 || manifestDigest(runtimeManifest) !== reviewedManifestDigest) throw fail();
  const plan = parseExternalCashHandoffPlan(await readPublic(join(base, handoffNames.plan)), {
    priorManifestDigest: LOCAL_CUSTOMER_MANIFEST, manifestDigest: reviewedManifestDigest,
  });
  const e = await readPublic(join(base, handoffNames.evidence));
  const fields = 'schemaVersion,planDigest,priorManifestDigest,manifestDigest,priorInitialNonce,priorNextNonce,initialNonce,finalizedBlock,finalizedHash,oldJournalDigest';
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join(',') !== fields.split(',').sort().join(',')
    || e.schemaVersion !== 1 || e.planDigest !== digest(plan) || e.priorManifestDigest !== LOCAL_CUSTOMER_MANIFEST
    || e.manifestDigest !== reviewedManifestDigest || e.priorInitialNonce !== plan.reviewedPriorInitialNonce
    || e.priorNextNonce !== plan.reviewedFirstCreateNonce || e.initialNonce !== String(BigInt(plan.reviewedFirstCreateNonce) + 4n)
    || !/^[0-9a-f]{64}$/.test(e.oldJournalDigest) || !/^0x[0-9a-f]{64}$/.test(e.finalizedHash)
    || !/^(0|[1-9][0-9]*)$/.test(e.finalizedBlock)) throw fail();
  const identities = await Promise.all([priorJournal, journal].map(async pool =>
    (await pool.query('SELECT current_database() AS database, system_identifier::text AS system FROM pg_control_system()')).rows[0]));
  if (identities[0]?.database !== 'arco_signer_journal' || identities[1]?.database !== TUSDC_JOURNAL_DATABASE
    || identities[0].system !== identities[1].system) throw fail();
  await requireIsolatedJournalSchemas(priorJournal, journal);
  const signer = runtimeManifest.signerAddress.toLowerCase();
  const priorAccount = (await priorJournal.query(`SELECT "networkInstance","checkpointNumber","checkpointHash",
    "initialNonce"::text AS "initialNonce","nextNonce"::text AS "nextNonce"
    FROM stocks_signer.account_nonce WHERE "chainId"=91342 AND "signerAddress"=$1`, [signer])).rows[0];
  const operations = (await priorJournal.query(`SELECT o."operationId",o."deploymentDigest",o."originalNonce"::text AS "originalNonce",
    o."txHash",o.call,i."signedHash" FROM stocks_signer.operation o LEFT JOIN stocks_signer.signed_intent i USING ("operationId")
    WHERE o."chainId"=91342 AND o."signerAddress"=$1 ORDER BY o."originalNonce"`, [signer])).rows;
  if (digest({ account: priorAccount, operations }) !== e.oldJournalDigest) throw fail();
  const account = (await journal.query(`SELECT "chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash",
    "initialNonce"::text AS "initialNonce","nextNonce"::text AS "nextNonce" FROM stocks_signer.account_nonce`)).rows;
  const row = account[0];
  if (account.length !== 1 || row.chainId !== 91342 || row.signerAddress !== signer || row.networkInstance !== runtimeManifest.networkInstance
    || row.checkpointNumber !== runtimeManifest.checkpointNumber || row.checkpointHash !== runtimeManifest.checkpointHash
    || row.initialNonce !== e.initialNonce || !/^(0|[1-9][0-9]*)$/.test(row.nextNonce) || BigInt(row.nextNonce) < BigInt(e.initialNonce)) throw fail();
  await requireEmptyPriorStocksEpoch(productPool, LOCAL_CUSTOMER_MANIFEST);
  return Object.freeze({ initialNonce: e.initialNonce, planDigest: e.planDigest });
}
