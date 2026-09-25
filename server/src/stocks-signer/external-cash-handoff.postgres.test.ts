import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { authorizedCall } from '../stocks/chain.js';
import { callDigest, manifestDigest, type SqlPool } from '../stocks/contracts.js';
import { a } from '../stocks/test-fixtures.js';
import { PostgresSignerJournal } from './postgres-journal.js';
import { externalCashFixture } from './external-cash-handoff-fixture.js';
import { parseExternalCashHandoffPlan, verifyExternalCashHandoff, seedExternalCashJournal, requireEmptyPriorStocksEpoch } from './external-cash-handoff.js';
const enabled = process.env.STOCKS_HANDOFF_TEST_ONLY === '1' && !!process.env.STOCKS_HANDOFF_PRIOR_DATABASE_URL && !!process.env.STOCKS_HANDOFF_NEXT_DATABASE_URL;
const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void> } };
test('real Postgres handoff preserves prior epoch; new seed is isolated, atomic, replayable and never reseeds an active journal', { skip: !enabled }, async () => {
  const prior = new Pool({ connectionString: process.env.STOCKS_HANDOFF_PRIOR_DATABASE_URL, max: 4 });
  let next = new Pool({ connectionString: process.env.STOCKS_HANDOFF_NEXT_DATABASE_URL, max: 4 });
  const f = externalCashFixture();
  const plan = parseExternalCashHandoffPlan(f.plan, { priorManifestDigest: f.plan.reviewedPriorManifestDigest, manifestDigest: f.plan.reviewedManifestDigest });
  try {
    await prior.query(`INSERT INTO stocks_signer.account_nonce ("chainId","signerAddress","networkInstance","checkpointNumber","checkpointHash","initialNonce","nextNonce") VALUES(91342,$1,$2,$3,$4,20,20)`,
      [f.plan.priorManifest.signerAddress, f.account.networkInstance, f.account.checkpointNumber, f.account.checkpointHash]);
    const oldBefore = (await prior.query('SELECT row_to_json(a) AS row FROM stocks_signer.account_nonce a')).rows;
    const evidence = await verifyExternalCashHandoff({ plan, priorJournal: prior, rpc: f.rpc, requirePriorEpoch: async () => {} });
    await assert.rejects(seedExternalCashJournal({ plan, evidence, priorJournal: prior, journal: prior }), /TUSDC_JOURNAL_ISOLATION_REQUIRED/);
    await Promise.all([1,2,3].map(() => seedExternalCashJournal({ plan, evidence, priorJournal: prior, journal: next })));
    assert.deepEqual((await prior.query('SELECT row_to_json(a) AS row FROM stocks_signer.account_nonce a')).rows, oldBefore);
    assert.equal((await next.query('SELECT "initialNonce"::text AS n FROM stocks_signer.account_nonce')).rows[0].n, '24');
    // Response-loss/restart: the same prepared seed is recovered through a new pool.
    await next.end(); next = new Pool({ connectionString: process.env.STOCKS_HANDOFF_NEXT_DATABASE_URL, max: 4 });
    await seedExternalCashJournal({ plan, evidence, priorJournal: prior, journal: next });
    const journal = new PostgresSignerJournal(next, plan.manifest, evidence.initialNonce);
    const call = authorizedCall(plan.manifest, 'mint:after-handoff', 'MINT', a(10), '1');
    const input = { operationId: call.operationId, deploymentDigest: manifestDigest(plan.manifest), callDigest: callDigest(call), call };
    const reserved = await Promise.all([1,2,3].map(() => journal.reserve(input)));
    assert.equal(reserved.filter(r => r.created).length, 1);
    assert.ok(reserved.every(r => r.operation.originalNonce === '24'));
    await assert.rejects(seedExternalCashJournal({ plan, evidence, priorJournal: prior, journal: next }), /TUSDC_JOURNAL_ALREADY_ACTIVE/);
    assert.deepEqual((await prior.query('SELECT row_to_json(a) AS row FROM stocks_signer.account_nonce a')).rows, oldBefore);
    assert.equal((await prior.query('SELECT COUNT(*)::text AS n FROM stocks_signer.operation')).rows[0].n, '0');
    await assert.rejects(next.query('UPDATE stocks_signer.account_nonce SET "nextNonce"=20'), /SIGNER_ACCOUNT_NONCE_MUTATION_FORBIDDEN/);
  } finally { await Promise.all([prior.end(), next.end()]); }
});
test('real Postgres prior epoch gate requires authoritative pause and rejects existing customer order history', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: process.env.STOCKS_HANDOFF_PRIOR_DATABASE_URL, max: 2 });
  const d = 'e'.repeat(64);
  try {
    await assert.rejects(requireEmptyPriorStocksEpoch(pool, d), /TUSDC_PRIOR_EPOCH_NOT_EMPTY_OR_PAUSED/);
    await pool.query('INSERT INTO arco_evm."StocksTradingControl" ("deploymentDigest",paused,version) VALUES ($1,true,0)', [d]);
    await requireEmptyPriorStocksEpoch(pool, d);
    // An unresolved outbox record alone blocks epoch retirement; no row is removed.
    await pool.query(`INSERT INTO arco_evm."StocksOutbox" (id,kind,payload,"deploymentDigest") VALUES('handoff-review','BROKER','{}',$1)`, [d]);
    await assert.rejects(requireEmptyPriorStocksEpoch(pool, d), /TUSDC_PRIOR_EPOCH_NOT_EMPTY_OR_PAUSED/);
  } finally { await pool.end(); }
});
