import assert from 'node:assert/strict';
import pg from 'pg';
import { authorizedCall } from '../../server/dist/stocks/chain.js';
import { address, callDigest, manifestDigest } from '../../server/dist/stocks/contracts.js';
import { a, h, testManifest } from '../../server/dist/stocks/test-fixtures.js';
import { PostgresSignerJournal } from '../../server/dist/stocks-signer/postgres-journal.js';

if (process.env.STOCKS_SIGNER_TEST_ONLY !== '1' || !process.env.STOCKS_SIGNER_TEST_DATABASE_URL)
  throw new Error('SIGNER_RESTART_PROBE_REQUIRES_OWNED_TEST_DATABASE');
const phase = process.argv[2];
if (!['seed', 'verify'].includes(phase) || process.argv.length !== 3) throw new Error('SIGNER_RESTART_PROBE_PHASE_INVALID');
const pool = new pg.Pool({ connectionString: process.env.STOCKS_SIGNER_TEST_DATABASE_URL, max: 2 });
const manifest = { ...testManifest(), signerAddress: a(206) };
const journal = new PostgresSignerJournal(pool, manifest, '612');
const first = authorizedCall(manifest, 'mint:restart-original', 'MINT', a(10), '10');
const next = authorizedCall(manifest, 'mint:restart-next', 'MINT', a(10), '11');
const input = call => ({ operationId: call.operationId, deploymentDigest: manifestDigest(manifest),
  callDigest: callDigest(call), call });

try {
  if (phase === 'seed') {
    await pool.query(`INSERT INTO stocks_signer.account_nonce
      ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce")
      VALUES (91342,$1,$2,$3,$4,612,612)`, [address(manifest.signerAddress), manifest.networkInstance,
      manifest.checkpointNumber, manifest.checkpointHash]);
    assert.equal((await journal.reserve(input(first))).operation.originalNonce, '612');
    console.log('SIGNER_RESTART_ORIGINAL_RESERVED');
  } else {
    const original = await journal.read(first.operationId);
    assert.equal(original?.originalNonce, '612');
    assert.equal(original?.txHash, null);
    await assert.rejects(journal.reserve(input(next)), /SIGNER_ORIGINAL_OUTCOME_UNKNOWN/);
    await journal.recordHash(first.operationId, callDigest(first), h(83));
    assert.equal((await journal.reserve(input(next))).operation.originalNonce, '613');
    console.log('SIGNER_RESTART_ORIGINAL_RECOVERED');
  }
} finally { await pool.end(); }
