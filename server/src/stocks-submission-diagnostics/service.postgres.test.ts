import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { enabled, fixture } from '../stocks-submissions/test-fixtures.js';
import { addSubmission } from '../stocks-submissions/receipts-fixtures.js';
import { createSubmissionReceiptVerifier } from '../stocks-submissions/receipts.js';
import { StocksSubmissionsService } from '../stocks-submissions/service.js';
import { enrollWalletSubmission } from '../stocks-submissions/enrollment.js';
import { h, TestChain } from '../stocks/test-fixtures.js';
import { operationKey, type SqlClient, type SqlPool } from '../stocks/contracts.js';
import { StocksRepository } from '../stocks/repository.js';
import { StocksService } from '../stocks/service.js';
import type { Side } from '../stocks-submissions/contracts.js';
import { StocksSubmissionDiagnosticsService } from './service.js';

const options = { skip: !enabled };
type Fixture = Awaited<ReturnType<typeof fixture>>;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function monitoredStocks(f: Fixture, connect: SqlPool['connect']) {
  return new StocksService(new StocksRepository({ connect, query: f.pool.query.bind(f.pool) }, f.stocks.digest), f.manifest, f.stocks.verifier,
    { manifestDigest: f.stocks.digest, contractPolicyVerified: true }, async () => { throw new Error('DIAGNOSTICS_MUST_NOT_CHECK_PAUSE'); });
}
async function facts(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of ['StocksWalletSubmissionEnrollment', 'StocksWalletSubmission', 'StocksWalletSubmissionProof', 'StocksAudit', 'StocksOrder', 'StocksSellOrder']) {
    result[table] = (await f.pool.query(`SELECT to_jsonb(t) AS value FROM arco_evm."${table}" t WHERE "deploymentDigest"=$1 ORDER BY to_jsonb(t)::text`, [f.stocks.digest])).rows;
  }
  return result;
}
// New fixture rows only: never backdate an immutable live order or remove enrollment.
async function insertedOrder(f: Fixture, side: Side, enroll: boolean, ttlMs: number) {
  const source = await f.order(side), id = randomUUID(), quoteId = randomUUID();
  const quoteTable = side === 'BUY' ? 'StocksQuote' : 'StocksSellQuote';
  const table = side === 'BUY' ? 'StocksOrder' : 'StocksSellOrder';
  return f.repo.tx(async db => {
    await db.query(`INSERT INTO arco_evm."${quoteTable}" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") SELECT $2,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest",clock_timestamp()+($3::text||' milliseconds')::interval FROM arco_evm."${quoteTable}" WHERE id=$1`, [source.quoteId, quoteId, ttlMs]);
    const order = (await db.query(`INSERT INTO arco_evm."${table}" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") SELECT $2,$3,$4,"actorId",wallet,symbol,quantity,"cashAmount",$5,"deploymentId","deploymentDigest",(SELECT "expiresAt" FROM arco_evm."${quoteTable}" WHERE id=$4) FROM arco_evm."${table}" WHERE id=$1 RETURNING *`, [source.id, id, operationKey(`${side === 'SELL' ? 'sell:' : ''}${f.manifest.networkInstance}:${id}`), quoteId, `diagnostics:${id}`])).rows[0];
    if (enroll) await enrollWalletSubmission(db, f.manifest, order, side);
    return order;
  });
}
for (const side of ['BUY', 'SELL'] as const) {
  test(`real PG diagnostics ${side}: all durable states, trusted receipts and order completion remain distinct`, options, async t => {
    const f = await fixture(); t.after(() => f.pool.end());
    const diagnostic = new StocksSubmissionDiagnosticsService(f.stocks), chain = new TestChain(f.manifest);
    const journal = new StocksSubmissionsService(f.stocks, createSubmissionReceiptVerifier(f.manifest, chain));
    for (const terminal of ['CONFIRMED', 'REVERTED'] as const) {
      const order = await f.order(side), claim = (await journal.claim(f.actor, f.request(order, side, 'APPROVAL')))!;
      let snapshot = await diagnostic.inspect(side, order.id);
      assert.equal(snapshot.data.enrollment, 'ENROLLED');
      assert.equal(snapshot.data.approval?.status, 'REQUEST_MAY_START'); assert.equal(snapshot.data.approval?.txHash, null);
      assert.equal(snapshot.data.approval?.receipt, null); assert.equal(snapshot.data.transfer, null);
      await journal.record(f.actor, { ...claim, status: 'UNKNOWN' });
      snapshot = await diagnostic.inspect(side, order.id);
      assert.equal(snapshot.data.approval?.status, 'UNKNOWN'); assert.equal(snapshot.data.approval?.txHash, null);
      const txHash = terminal === 'CONFIRMED' ? h(920) : h(921);
      await journal.record(f.actor, { ...claim, status: 'SUBMITTED', txHash });
      snapshot = await diagnostic.inspect(side, order.id);
      assert.equal(snapshot.data.approval?.status, 'SUBMITTED'); assert.equal(snapshot.data.approval?.txHash, txHash); assert.equal(snapshot.data.approval?.receipt, null);
      addSubmission(chain, f.manifest, order, side, 'APPROVAL', txHash);
      if (terminal === 'REVERTED') { chain.receipts.get(txHash)!.status = 'reverted'; chain.receipts.get(txHash)!.logs = []; }
      await journal.reconcile(f.actor, { claimId: claim.claimId, intentKey: claim.intentKey, stage: claim.stage, transactionDigest: claim.transactionDigest, txHash });
      const before = await facts(f);
      const verified = await diagnostic.inspect(side, order.id);
      assert.equal(verified.data.approval?.status, terminal); assert.equal(verified.data.approval?.receipt?.status, terminal);
      assert.equal(verified.data.approval?.receipt?.blockNumber, '10'); assert.equal(verified.data.approval?.receipt?.blockHash, h(10));
      assert.ok(Number.isFinite(Date.parse(verified.data.approval!.receipt!.verifiedAt)));
      assert.equal(verified.data.order.state, side === 'BUY' ? 'AWAITING_FUNDING' : 'AWAITING_ESCROW');
      assert.equal(verified.data.executionAuthorization, false); assert.equal(verified.data.resubmissionAllowed, false); assert.equal(verified.data.readOnly, true);
      assert.deepEqual(await facts(f), before);
      if (terminal === 'CONFIRMED') {
        const transfer = (await journal.claim(f.actor, f.request(order, side, 'TRANSFER')))!;
        addSubmission(chain, f.manifest, order, side, 'TRANSFER', h(922));
        await journal.record(f.actor, { ...transfer, status: 'SUBMITTED', txHash: h(922) });
        await journal.reconcile(f.actor, { claimId: transfer.claimId, intentKey: transfer.intentKey, stage: transfer.stage, transactionDigest: transfer.transactionDigest, txHash: h(922) });
        snapshot = await diagnostic.inspect(side, order.id);
        assert.equal(snapshot.data.transfer?.receipt?.status, 'CONFIRMED');
        assert.equal(snapshot.data.order.state, side === 'BUY' ? 'AWAITING_FUNDING' : 'AWAITING_ESCROW');
        assert.equal(snapshot.data.executionAuthorization, false);
      }
    }
  });
  test(`real PG diagnostics ${side}: expired paused claims and unenrolled historical orders remain readable without permission`, options, async t => {
    const f = await fixture(); t.after(() => f.pool.end());
    const order = await insertedOrder(f, side, true, 1200);
    const claim = (await f.service.claim(f.actor, f.request(order, side, 'APPROVAL')))!;
    await f.service.record(f.actor, { ...claim, status: 'UNKNOWN' });
    const historical = await insertedOrder(f, side, false, -1000);
    f.pause(true);
    await sleep(Math.max(0, new Date(order.quoteExpiresAt).getTime() - Date.now() + 30));
    const diagnostic = new StocksSubmissionDiagnosticsService(f.stocks), before = await facts(f);
    const current = await diagnostic.inspect(side, order.id);
    assert.equal(current.data.order.quoteExpired, true); assert.equal(current.data.approval?.status, 'UNKNOWN');
    assert.equal(current.data.approval?.claimId, claim.claimId); assert.equal(current.data.resubmissionAllowed, false);
    const old = await diagnostic.inspect(side, historical.id);
    assert.equal(old.data.enrollment, 'NOT_ENROLLED'); assert.equal(old.data.order.quoteExpired, true);
    assert.equal(old.data.approval, null); assert.equal(old.data.transfer, null); assert.equal(old.data.executionAuthorization, false); assert.equal(old.data.resubmissionAllowed, false);
    assert.deepEqual(await facts(f), before);
  });
  test(`real PG diagnostics ${side}: repeatable-read snapshot never combines pending claim with concurrently committed proof`, options, async t => {
    const f = await fixture(); t.after(() => f.pool.end());
    const order = await f.order(side), chain = new TestChain(f.manifest);
    const journal = new StocksSubmissionsService(f.stocks, createSubmissionReceiptVerifier(f.manifest, chain));
    const claim = (await journal.claim(f.actor, f.request(order, side, 'APPROVAL')))!;
    await journal.record(f.actor, { ...claim, status: 'SUBMITTED', txHash: h(923) });
    addSubmission(chain, f.manifest, order, side, 'APPROVAL', h(923));
    let transition = false, readOnlyChecked = false;
    const queries: string[] = [], connect = f.pool.connect.bind(f.pool);
    const wrapped = async (): Promise<SqlClient> => {
      const db = await connect(), query = db.query.bind(db);
      return { release: () => db.release(), query: async (sql, values) => {
        queries.push(sql); const result = await query(sql, values);
        if (/^BEGIN/i.test(sql)) {
          assert.equal((await query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
          assert.equal((await query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read'); readOnlyChecked = true;
        }
        if (!transition && /\bSELECT\b/i.test(sql) && /"Stocks(?:Sell)?Order"/.test(sql)) {
          transition = true;
          await journal.reconcile(f.actor, { claimId: claim.claimId, intentKey: claim.intentKey, stage: claim.stage, transactionDigest: claim.transactionDigest, txHash: h(923) });
        }
        return result;
      } };
    };
    const diagnostic = new StocksSubmissionDiagnosticsService(monitoredStocks(f, wrapped));
    const snapshot = await diagnostic.inspect(side, order.id);
    assert.equal(transition, true); assert.equal(readOnlyChecked, true);
    assert.equal(snapshot.data.approval?.status, 'SUBMITTED'); assert.equal(snapshot.data.approval?.receipt, null);
    assert.ok(queries.every(sql => !/\b(INSERT|UPDATE|DELETE|TRUNCATE|LOCK)\b|pg_advisory|FOR SHARE/i.test(sql)));
    const next = await new StocksSubmissionDiagnosticsService(f.stocks).inspect(side, order.id);
    assert.equal(next.data.approval?.status, 'CONFIRMED'); assert.equal(next.data.approval?.receipt?.status, 'CONFIRMED');
  });
}
test('real PG diagnostics: current deployment boundary hides foreign order and leaves all facts unchanged', options, async t => {
  const f = await fixture(), other = await fixture(); t.after(() => f.pool.end()); t.after(() => other.pool.end());
  const diagnostic = new StocksSubmissionDiagnosticsService(f.stocks);
  for (const side of ['BUY', 'SELL'] as const) {
    const foreign = await other.order(side), before = await facts(f);
    await assert.rejects(diagnostic.inspect(side, foreign.id), (error: unknown) => error instanceof Error && error.message === 'ORDER_NOT_FOUND' && (error as {status?: number}).status === 404);
    assert.deepEqual(await facts(f), before);
  }
});
test('real PG diagnostics: exclusive table lock has bounded denial, cleanup and subsequent successful read', options, async t => {
  const f = await fixture(); t.after(() => f.pool.end()); const order = await f.order(), locker = await f.pool.connect();
  const before = await facts(f), diagnostic = new StocksSubmissionDiagnosticsService(f.stocks);
  try {
    await locker.query('BEGIN'); await locker.query('LOCK TABLE arco_evm."StocksOrder" IN ACCESS EXCLUSIVE MODE');
    const started = performance.now();
    await assert.rejects(diagnostic.inspect('BUY', order.id), (error: unknown) => error instanceof Error && /DIAGNOSTICS.*(TIMEOUT|UNAVAILABLE)/.test(error.message) && (error as {status?: number}).status === 503);
    assert.ok(performance.now() - started < 4000, 'database wait must remain bounded');
  } finally { await locker.query('ROLLBACK'); locker.release(); }
  assert.equal((await diagnostic.inspect('BUY', order.id)).data.order.id, order.id);
  assert.deepEqual(await facts(f), before);
});
