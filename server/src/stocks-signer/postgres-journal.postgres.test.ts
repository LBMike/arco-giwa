import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { authorizedCall } from '../stocks/chain.js';
import { address, callDigest, manifestDigest, StocksError, type AuthorizedCall, type Manifest, type SqlPool } from '../stocks/contracts.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import { createStocksSignerCore } from './core.js';
import { PostgresSignerJournal } from './postgres-journal.js';

const enabled = process.env.STOCKS_SIGNER_TEST_ONLY === '1' && !!process.env.STOCKS_SIGNER_TEST_DATABASE_URL;
const require = createRequire(import.meta.url);
const { Pool } = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void> } };
const connectionString = process.env.STOCKS_SIGNER_TEST_DATABASE_URL;
const manifestFor = (n: number): Manifest => ({ ...testManifest(), signerAddress: a(n) });
const input = (manifest: Manifest, call: AuthorizedCall) => ({
  operationId: call.operationId, deploymentDigest: manifestDigest(manifest), callDigest: callDigest(call), call,
});
const request = (manifest: Manifest, call: AuthorizedCall) => ({
  protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest: manifestDigest(manifest), callDigest: callDigest(call), call,
});
async function seed(pool: SqlPool, manifest: Manifest, initialNonce: string) {
  await pool.query(`INSERT INTO stocks_signer.account_nonce
    ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce")
    VALUES (91342,$1,$2,$3,$4,$5::numeric,$5::numeric)`,
  [address(manifest.signerAddress), manifest.networkInstance, manifest.checkpointNumber, manifest.checkpointHash, initialNonce]);
}

test('PostgreSQL signer journal requires an explicit seeded account and original nonce', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString, max: 4 });
  try {
    const manifest = manifestFor(200);
    const call = authorizedCall(manifest, 'mint:unseeded', 'MINT', a(10), '10');
    const journal = new PostgresSignerJournal(pool, manifest, '7');
    await assert.rejects(journal.reserve(input(manifest, call)), /SIGNER_ACCOUNT_NOT_INITIALIZED/);
    await assert.rejects(pool.query(`INSERT INTO stocks_signer.account_nonce
      ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce")
      VALUES (91342,$1,$2,$3,$4,7,8)`, [address(manifest.signerAddress), manifest.networkInstance,
        manifest.checkpointNumber, manifest.checkpointHash]), /SIGNER_ACCOUNT_NONCE_SEED_INVALID/);
    await seed(pool, manifest, '7');
    await assert.rejects(pool.query(`UPDATE stocks_signer.account_nonce SET "nextNonce"="nextNonce"+1
      WHERE "signerAddress"=$1`, [address(manifest.signerAddress)]),
    /SIGNER_ACCOUNT_NONCE_ADVANCE_WITHOUT_OPERATION/);
    const resetManifest = { ...manifest, networkInstance: 'other-network-instance-001' };
    const resetCall = authorizedCall(resetManifest, 'mint:after-network-reset', 'MINT', a(10), '10');
    await assert.rejects(new PostgresSignerJournal(pool, resetManifest, '7').reserve(input(resetManifest, resetCall)),
      /SIGNER_ACCOUNT_NETWORK_MISMATCH/);
    const hashChangedManifest = { ...manifest, checkpointHash: h(90) };
    const hashChangedCall = authorizedCall(hashChangedManifest, 'mint:after-checkpoint-hash-change', 'MINT', a(10), '10');
    await assert.rejects(new PostgresSignerJournal(pool, hashChangedManifest, '7').reserve(input(hashChangedManifest, hashChangedCall)),
      /SIGNER_ACCOUNT_NETWORK_MISMATCH/);
    const numberChangedManifest = { ...manifest, checkpointNumber: '2' };
    const numberChangedCall = authorizedCall(numberChangedManifest, 'mint:after-checkpoint-number-change', 'MINT', a(10), '10');
    await assert.rejects(new PostgresSignerJournal(pool, numberChangedManifest, '7').reserve(input(numberChangedManifest, numberChangedCall)),
      /SIGNER_ACCOUNT_NETWORK_MISMATCH/);
    await assert.rejects(pool.query(`UPDATE stocks_signer.account_nonce SET "networkInstance"=$2,"nextNonce"="nextNonce"+1
      WHERE "signerAddress"=$1`, [address(manifest.signerAddress), resetManifest.networkInstance]),
    /SIGNER_ACCOUNT_NONCE_MUTATION_FORBIDDEN/);
    await assert.rejects(pool.query(`UPDATE stocks_signer.account_nonce SET "checkpointHash"=$2,"nextNonce"="nextNonce"+1
      WHERE "signerAddress"=$1`, [address(manifest.signerAddress), h(90)]),
    /SIGNER_ACCOUNT_NONCE_MUTATION_FORBIDDEN/);
    await assert.rejects(new PostgresSignerJournal(pool, manifest, '8').reserve(input(manifest, call)), /SIGNER_ACCOUNT_NONCE_MISMATCH/);
    assert.throws(() => new PostgresSignerJournal(pool, manifest, '07'), /SIGNER_NONCE_INVALID/);
    const result = await journal.reserve(input(manifest, call));
    assert.equal(result.created, true);
    assert.equal(result.operation.originalNonce, '7');
    assert.equal(result.operation.txHash, null);
    assert.equal(await journal.readSignedHash(result.operation), null);
    await assert.rejects(journal.recordHash(call.operationId, callDigest(call), h(39)), /SIGNER_SIGNED_INTENT_REQUIRED/);
    assert.equal(await journal.recordSignedHash(result.operation, h(39)), h(39));
    assert.equal(await journal.readSignedHash(result.operation), h(39));
    const account = (await pool.query('SELECT "nextNonce"::text AS nonce FROM stocks_signer.account_nonce WHERE "signerAddress"=$1',
      [address(manifest.signerAddress)])).rows[0];
    assert.equal(account.nonce, '8');
  } finally { await pool.end(); }
});

test('PostgreSQL reserves one immutable original, blocks later nonce while unknown, and resumes after original hash', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString, max: 6 });
  const manifest = { ...manifestFor(201), networkInstance: 'n'.repeat(128) };
  try {
    await seed(pool, manifest, '19');
    const journal = new PostgresSignerJournal(pool, manifest, '19');
    const first = authorizedCall(manifest, 'mint:pg-first', 'MINT', a(10), '10');
    const fundingId = `${manifest.networkInstance}:${h(99)}:3`;
    const second = authorizedCall(manifest, `refund:${fundingId}`, 'REFUND', a(10), '11');
    const original = await journal.reserve(input(manifest, first));
    assert.equal(original.operation.originalNonce, '19');
    assert.equal((await journal.reserve(input(manifest, first))).created, false);
    const changed = authorizedCall(manifest, first.operationId, 'MINT', a(10), '12');
    await assert.rejects(journal.reserve(input(manifest, changed)), /SIGNER_IMMUTABLE_OPERATION_CONFLICT/);
    await assert.rejects(journal.reserve(input(manifest, second)), /SIGNER_ORIGINAL_OUTCOME_UNKNOWN/);
    assert.equal(await journal.read(second.operationId), null);
    await assert.rejects(journal.recordHash(first.operationId, callDigest(first), h(40)), /SIGNER_SIGNED_INTENT_REQUIRED/);
    assert.equal(await journal.recordSignedHash(original.operation, h(40)), h(40));
    assert.equal(await journal.recordSignedHash(original.operation, h(40)), h(40));
    await assert.rejects(journal.recordSignedHash({ ...original.operation, originalNonce: '20' }, h(40)),
      /SIGNER_IMMUTABLE_OPERATION_CONFLICT/);
    await assert.rejects(journal.readSignedHash({ ...original.operation, callDigest: 'f'.repeat(64) }),
      /SIGNER_IMMUTABLE_OPERATION_CONFLICT/);
    await assert.rejects(journal.recordSignedHash(original.operation, h(41)), /SIGNER_SIGNED_HASH_CONFLICT/);
    await assert.rejects(journal.recordHash(first.operationId, callDigest(first), h(41)), /SIGNER_SIGNED_INTENT_MISMATCH/);
    assert.equal((await journal.recordHash(first.operationId, callDigest(first), h(40))).txHash, h(40));
    assert.equal((await journal.recordHash(first.operationId, callDigest(first), h(40))).txHash, h(40));
    await assert.rejects(journal.recordHash(first.operationId, callDigest(first), h(41)), /SIGNER_SIGNED_INTENT_MISMATCH/);
    const next = await journal.reserve(input(manifest, second));
    assert.equal(next.operation.originalNonce, '20');
    assert.equal(next.operation.operationId, second.operationId);
    await assert.rejects(journal.recordSignedHash(next.operation, h(40)), /SIGNER_JOURNAL_UNAVAILABLE/);
    assert.equal(await journal.recordSignedHash(next.operation, h(42)), h(42));
    await assert.rejects(pool.query(`UPDATE stocks_signer.operation SET "txHash"=$2,"hashRecordedAt"=clock_timestamp()
      WHERE "operationId"=$1`, [second.operationId, h(43)]), /SIGNER_OPERATION_SIGNED_INTENT_MISMATCH/);
    const forged = authorizedCall(manifest, 'mint:forged-complete', 'MINT', a(10), '12');
    await assert.rejects(pool.query(`INSERT INTO stocks_signer.operation
      ("operationId","chainId","signerAddress","deploymentDigest","callDigest",call,"originalNonce","txHash","hashRecordedAt")
      VALUES ($1,91342,$2,$3,$4,$5::jsonb,21,$6,clock_timestamp())`,
      [forged.operationId, address(manifest.signerAddress), manifestDigest(manifest), callDigest(forged),
        JSON.stringify(forged), h(71)]), /SIGNER_OPERATION_INSERT_HASH_FORBIDDEN/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stocks_signer.operation WHERE "signerAddress"=$1',
      [address(manifest.signerAddress)])).rows[0].n, 2);
    await assert.rejects(pool.query('UPDATE stocks_signer.operation SET call=$2::jsonb WHERE "operationId"=$1',
      [first.operationId, JSON.stringify(changed)]), /SIGNER_OPERATION_IMMUTABLE/);
    await assert.rejects(pool.query('DELETE FROM stocks_signer.operation WHERE "operationId"=$1', [first.operationId]), /SIGNER_OPERATION_DELETE_FORBIDDEN/);
    await assert.rejects(pool.query('UPDATE stocks_signer.signed_intent SET "signedHash"=$2 WHERE "operationId"=$1',
      [first.operationId, h(41)]), /SIGNER_SIGNED_INTENT_IMMUTABLE/);
    await assert.rejects(pool.query('DELETE FROM stocks_signer.signed_intent WHERE "operationId"=$1',
      [first.operationId]), /SIGNER_SIGNED_INTENT_IMMUTABLE/);
    await assert.rejects(pool.query('TRUNCATE stocks_signer.signed_intent'), /SIGNER_SIGNED_INTENT_IMMUTABLE/);
    await assert.rejects(pool.query('UPDATE stocks_signer.account_nonce SET "nextNonce"=0 WHERE "signerAddress"=$1',
      [address(manifest.signerAddress)]), /SIGNER_ACCOUNT_NONCE_MUTATION_FORBIDDEN/);
  } finally { await pool.end(); }

  // A fresh pool and adapter see the committed unresolved row; no nonce reset.
  const reopened = new Pool({ connectionString, max: 4 });
  try {
    const journal = new PostgresSignerJournal(reopened, manifest, '19');
    const pendingId = `refund:${manifest.networkInstance}:${h(99)}:3`;
    assert.equal((await journal.read(pendingId))?.originalNonce, '20');
    const later = authorizedCall(manifest, 'mint:after-restart', 'MINT', a(10), '12');
    await assert.rejects(journal.reserve(input(manifest, later)), /SIGNER_ORIGINAL_OUTCOME_UNKNOWN/);
    const pending = await journal.read(pendingId);
    assert.ok(pending);
    assert.equal(await journal.readSignedHash(pending), h(42));
    await journal.recordHash(pendingId, pending.callDigest, h(42));
    assert.equal((await journal.reserve(input(manifest, later))).operation.originalNonce, '21');
  } finally { await reopened.end(); }
});

test('two PostgreSQL adapters serialize competing first reservations for one physical signer', { skip: !enabled }, async () => {
  const poolA = new Pool({ connectionString, max: 2 });
  const poolB = new Pool({ connectionString, max: 2 });
  const manifest = manifestFor(202);
  try {
    await seed(poolA, manifest, '3');
    const aJournal = new PostgresSignerJournal(poolA, manifest, '3');
    const bJournal = new PostgresSignerJournal(poolB, manifest, '3');
    const first = authorizedCall(manifest, 'mint:race-a', 'MINT', a(10), '10');
    const second = authorizedCall(manifest, 'mint:race-b', 'MINT', a(10), '11');
    const outcomes = await Promise.allSettled([aJournal.reserve(input(manifest, first)), bJournal.reserve(input(manifest, second))]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
    const winner = outcomes.find(outcome => outcome.status === 'fulfilled');
    assert.ok(winner && winner.status === 'fulfilled');
    assert.equal(winner.value.operation.originalNonce, '3');
    assert.equal((await poolA.query('SELECT "nextNonce"::text AS nonce FROM stocks_signer.account_nonce WHERE "signerAddress"=$1',
      [address(manifest.signerAddress)])).rows[0].nonce, '4');
  } finally { await poolA.end(); await poolB.end(); }
});

test('concurrent repeats of one operation share its original nonce and one immutable signed hash', { skip: !enabled }, async () => {
  const poolA = new Pool({ connectionString, max: 2 });
  const poolB = new Pool({ connectionString, max: 2 });
  const manifest = manifestFor(204);
  try {
    await seed(poolA, manifest, '101');
    const aJournal = new PostgresSignerJournal(poolA, manifest, '101');
    const bJournal = new PostgresSignerJournal(poolB, manifest, '101');
    const call = authorizedCall(manifest, 'mint:repeat-race', 'MINT', a(10), '10');
    const [aResult, bResult] = await Promise.all([aJournal.reserve(input(manifest, call)), bJournal.reserve(input(manifest, call))]);
    assert.equal(Number(aResult.created) + Number(bResult.created), 1);
    assert.equal(aResult.operation.originalNonce, '101');
    assert.equal(bResult.operation.originalNonce, '101');
    const hashes = await Promise.allSettled([
      aJournal.recordSignedHash(aResult.operation, h(80)),
      bJournal.recordSignedHash(bResult.operation, h(81)),
    ]);
    assert.equal(hashes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(hashes.filter(outcome => outcome.status === 'rejected').length, 1);
    const winner = hashes.find(outcome => outcome.status === 'fulfilled');
    assert.ok(winner && winner.status === 'fulfilled');
    assert.equal(await aJournal.readSignedHash(aResult.operation), winner.value);
    assert.equal(await bJournal.readSignedHash(bResult.operation), winner.value);
    assert.equal((await aJournal.read(call.operationId))?.txHash, null);
    await assert.rejects(bJournal.recordHash(call.operationId, callDigest(call), winner.value === h(80) ? h(81) : h(80)),
      /SIGNER_SIGNED_INTENT_MISMATCH/);
    assert.equal((await bJournal.recordHash(call.operationId, callDigest(call), winner.value)).txHash, winner.value);
    assert.equal((await aJournal.recordHash(call.operationId, callDigest(call), winner.value)).txHash, winner.value);
    assert.equal((await poolA.query('SELECT "nextNonce"::text AS nonce FROM stocks_signer.account_nonce WHERE "signerAddress"=$1',
      [address(manifest.signerAddress)])).rows[0].nonce, '102');
  } finally { await poolA.end(); await poolB.end(); }
});

test('different deployments on the same physical signer share one unresolved-nonce gate', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString, max: 4 });
  const manifestA = manifestFor(205);
  const manifestB = { ...manifestA, deploymentId: 'deployment-B-0001' };
  try {
    await seed(pool, manifestA, '500');
    const journalA = new PostgresSignerJournal(pool, manifestA, '500');
    const journalB = new PostgresSignerJournal(pool, manifestB, '500');
    const first = authorizedCall(manifestA, 'mint:deployment-a', 'MINT', a(10), '10');
    const second = authorizedCall(manifestB, 'mint:deployment-b', 'MINT', a(10), '11');
    const original = await journalA.reserve(input(manifestA, first));
    assert.equal(original.operation.originalNonce, '500');
    const reusedId = authorizedCall(manifestB, first.operationId, 'MINT', a(10), '10');
    await assert.rejects(journalB.reserve(input(manifestB, reusedId)), /SIGNER_IMMUTABLE_OPERATION_CONFLICT/);
    await assert.rejects(journalB.reserve(input(manifestB, second)), /SIGNER_ORIGINAL_OUTCOME_UNKNOWN/);
    await journalA.recordSignedHash(original.operation, h(82));
    await journalA.recordHash(first.operationId, callDigest(first), h(82));
    assert.equal((await journalB.reserve(input(manifestB, second))).operation.originalNonce, '501');
  } finally { await pool.end(); }
});

test('core with PostgreSQL journal keeps unknown send inert until original-ID lookup records its hash', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString, max: 4 });
  const manifest = manifestFor(203);
  try {
    await seed(pool, manifest, '1');
    const journal = new PostgresSignerJournal(pool, manifest, '1');
    const first = authorizedCall(manifest, 'mint:core-unknown', 'MINT', a(10), '10');
    const next = authorizedCall(manifest, 'mint:core-next', 'MINT', a(10), '11');
    let sends = 0, recovery = 0;
    const core = createStocksSignerCore({ manifest, journal, transport: {
      sendOnce: async operation => { sends++; assert.equal(operation.originalNonce, '1');
        await journal.recordSignedHash(operation, h(70)); throw Error('SIMULATED_LOST_RESPONSE'); },
      findOriginal: async operation => { recovery++; assert.equal(operation.originalNonce, '1'); return recovery === 1 ? null : h(70); },
    } });
    await assert.rejects(core.submit(first.operationId, request(manifest, first)), /SIGNER_ORIGINAL_OUTCOME_UNKNOWN/);
    const changed = authorizedCall(manifest, first.operationId, 'MINT', a(10), '12');
    await assert.rejects(core.submit(changed.operationId, request(manifest, changed)), error =>
      error instanceof StocksError && error.code === 'SIGNER_IMMUTABLE_OPERATION_CONFLICT' && error.status === 409);
    assert.equal(await core.submit(first.operationId, request(manifest, first)), null);
    await assert.rejects(core.submit(next.operationId, request(manifest, next)), /SIGNER_JOURNAL_UNAVAILABLE/);
    assert.equal(await core.lookup(first.operationId), null);
    assert.equal((await core.lookup(first.operationId))?.txHash, h(70));
    assert.equal(sends, 1);
    assert.equal((await journal.reserve(input(manifest, next))).operation.originalNonce, '2');
  } finally { await pool.end(); }
});
