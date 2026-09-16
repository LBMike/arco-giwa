import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { manifestDigest, type Actor, type SqlPool } from './contracts.js';
import { ReceiptVerifier } from './chain.js';
import { StocksRepository } from './repository.js';
import { StocksService } from './service.js';
import { StocksWorker } from './worker.js';
import { createDurableMockBroker } from './mock-broker.js';
import { stocksPlugin } from './plugin.js';
import { reconcileStocks } from './reconciliation.js';
import { a, h, ACTOR, TestChain, TestSigner, testManifest, eventLog } from './test-fixtures.js';
const require = createRequire(import.meta.url);
const enabled = process.env.STOCKS_TEST_HARNESS_ONLY === '1' && !!process.env.STOCKS_TEST_DATABASE_URL;
const pg = require('pg') as {
    Pool: new (options: unknown) => SqlPool & {
        end(): Promise<void>;
    };
};
async function fixture() {
    assert.equal(enabled, true);
    const pool = new pg.Pool({ connectionString: process.env.STOCKS_TEST_DATABASE_URL, max: 8 });
    const m = testManifest();
    m.deploymentId = `TEST_HARNESS_ONLY_${randomUUID()}`;
    m.networkInstance = `TEST_NETWORK_${randomUUID()}`;
    const repo = new StocksRepository(pool, manifestDigest(m));
    const rpc = new TestChain(m);
    const signer = new TestSigner();
    let paused = false;
    const service = new StocksService(repo, m, new ReceiptVerifier(m, rpc), { manifestDigest: manifestDigest(m), contractPolicyVerified: true }, async () => paused, async () => true);
    const broker = createDurableMockBroker(repo);
    const worker = new StocksWorker(service, broker, signer);
    const actor: Actor = { ...ACTOR, actorId: randomUUID() };
    const order = async (quantity = '1') => { const q = await service.quote(actor, 'NVDA', quantity); return service.createOrder(actor, q.id, `test:${randomUUID()}`); };
    const state = async (id: string) => (await repo.scopedOrders(actor.actorId, id))[0].state;
    const funding = async (o: Record<string, any>, cash = o.cashAmount, payer = actor.wallet, tx = h(200), timestamp?: string) => { rpc.funding(o.orderKey, cash, payer, tx, timestamp); return service.observeFunding(tx); };
    const eligible = async () => { await pool.query('UPDATE arco_evm."StocksOutbox" SET "leaseUntil"=NULL,"nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE "deploymentDigest"=$1 AND status NOT IN (\'DONE\',\'REVIEW\')', [repo.deploymentDigest]); };
    const complete = async (o: Record<string, any>) => {
        await funding(o);
        await worker.runOne();
        await worker.runOne();
        const call = signer.calls[signer.calls.length - 1]!;
        const submission = signer.receipts.get(call.operationId)!;
        rpc.confirmation(call, o.quantity, actor.wallet, 'MINT', submission.txHash);
        await eligible();
        await worker.runOne();
    };
    return { pool, m, repo, rpc, signer, service, broker, worker, actor, order, state, funding, eligible, complete, pause: (v: boolean) => { paused = v; } };
}
async function scenario(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) { const f = await fixture(); try {
    await work(f);
}
finally {
    await f.pool.end();
} }
const options = { skip: !enabled };
test('PG concurrent duplicate commands create one immutable quote/order and reject key/body reuse', options, async () => scenario(async (f) => {
    const q = await f.service.quote(f.actor, 'NVDA', '0.000000001');
    assert.equal(q.quantity, '1');
    assert.equal(q.cashAmount, '1');
    const commands = await Promise.all(Array.from({ length: 8 }, () => f.service.createOrder(f.actor, q.id, 'same-key-123')));
    assert.equal(new Set(commands.map(row => row.id)).size, 1);
    const other = await f.service.quote(f.actor, 'NVDA', '2');
    await assert.rejects(() => f.service.createOrder(f.actor, other.id, 'same-key-123'), /IDEMPOTENCY_CONFLICT/);
    await assert.rejects(() => f.service.createOrder({ ...f.actor, actorId: 'other' }, q.id, 'other-key-123'), /QUOTE_NOT_FOUND/);
    await assert.rejects(() => f.service.createOrder({ ...f.actor, wallet: a(66) }, q.id, 'other-key-123'), /QUOTE_NOT_FOUND/);
    await assert.rejects(() => f.pool.query('UPDATE arco_evm."StocksQuote" SET quantity=2 WHERE id=$1', [q.id]), /immutable/);
}));
test('PG buy to mint, duplicate chain replay, exact portfolio JSON and actor object authorization', options, async () => scenario(async (f) => {
    const o = await f.order('1.234567891');
    await f.complete(o);
    assert.equal(await f.state(o.id), 'COMPLETED');
    await f.service.observeFunding(h(200));
    assert.equal(await f.worker.runOne(), false);
    const holdings = await f.repo.portfolio(f.actor.actorId);
    assert.equal(holdings.holdings[0].quantity, '1234567891');
    assert.equal(holdings.pending.length, 0);
    const count = await f.pool.query('SELECT COUNT(*)::text AS n FROM arco_evm."StocksJournal" WHERE "deploymentDigest"=$1', [f.repo.deploymentDigest]);
    assert.equal(count.rows[0].n, '3');
    const app = Fastify();
    await app.register(stocksPlugin, { service: f.service, resolveActor: async () => f.actor, resolveOperator: async () => ({ operatorId: 'operator-123', permissions: ['stocks:read'] }) });
    const response = await app.inject({ url: '/api/v1/stocks/portfolio' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.holdings[0].quantity, '1234567891');
    for (const route of ['overview', 'orders', `orders/${o.id}`, 'reconciliations', 'audit'])
        assert.equal((await app.inject({ url: `/api/v1/admin/stocks/${route}` })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/stocks/orders/not-mine' })).statusCode, 404);
    await app.close();
}));
test('PG concurrent event replay credits once and concurrent workers dispatch one broker request', options, async () => scenario(async (f) => {
    const o = await f.order();
    f.rpc.funding(o.orderKey, o.cashAmount);
    await Promise.all(Array.from({ length: 8 }, () => f.service.observeFunding(h(200))));
    await Promise.all(Array.from({ length: 8 }, () => f.worker.runOne()));
    const count = await f.pool.query('SELECT COUNT(*)::text AS n FROM arco_evm."StocksProviderReceipt" WHERE "deploymentDigest"=$1', [f.repo.deploymentDigest]);
    assert.equal(count.rows[0].n, '1');
    assert.ok(['MINT_QUEUED', 'MINT_FINALITY_PENDING'].includes(await f.state(o.id)));
    assert.ok(f.signer.calls.length <= 1);
}));
test('PG broker timeout after receipt persisted recovers by original operation lookup across worker restart', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    const ambiguous = new StocksWorker(f.service, { submit: async (req) => { await f.broker.submit(req); throw new Error('crash after broker'); }, lookup: f.broker.lookup }, f.signer);
    await ambiguous.runOne();
    assert.equal(await f.state(o.id), 'BROKER_UNKNOWN');
    await f.eligible();
    await new StocksWorker(f.service, createDurableMockBroker(new StocksRepository(f.pool, f.repo.deploymentDigest)), f.signer).runOne();
    assert.equal(await f.state(o.id), 'MINT_QUEUED');
}));
test('PG signer timeout after submission recovers original hash, never resubmits, pause still permits confirmation', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    await f.worker.runOne();
    f.signer.throwAfterSubmit = true;
    await f.worker.runOne();
    assert.equal(await f.state(o.id), 'MINT_UNKNOWN');
    assert.equal(f.signer.calls.length, 1);
    const call = f.signer.calls[0];
    f.rpc.confirmation(call, o.quantity, f.actor.wallet, 'MINT', f.signer.receipts.get(call.operationId)!.txHash);
    f.pause(true);
    await f.eligible();
    await new StocksWorker(f.service, f.broker, f.signer).runOne();
    assert.equal(await f.state(o.id), 'COMPLETED');
    assert.equal(f.signer.calls.length, 1);
}));
test('PG unknown absent signer outcome stays unknown with funds retained, never returns to pending', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    await f.worker.runOne();
    let submits = 0;
    const worker = new StocksWorker(f.service, f.broker, { submit: async () => { submits++; throw new Error('unknown'); }, lookup: async () => null });
    await worker.runOne();
    await f.eligible();
    await worker.runOne();
    assert.equal(submits, 1);
    assert.equal(await f.state(o.id), 'MINT_UNKNOWN');
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings.length, 0);
}));
test('PG pause blocks new broker/mint dispatch and unpause allows original pending intent', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    f.pause(true);
    assert.equal(await f.worker.runOne(), false);
    await assert.rejects(() => f.service.quote(f.actor, 'NVDA', '1'), /STOCKS_PAUSED/);
    f.pause(false);
    assert.equal(await f.worker.runOne(), true);
    assert.equal(await f.state(o.id), 'MINT_QUEUED');
}));
test('PG wrong-wallet dust remains suspense and cannot block legitimate exact funding', options, async () => scenario(async (f) => {
    const o = await f.order();
    const wrong = await f.funding(o, '1', a(88)) as Record<string, any>;
    assert.equal(wrong.reason, 'WRONG_WALLET');
    assert.equal(await f.state(o.id), 'AWAITING_FUNDING');
    await assert.rejects(() => f.service.requestRefund(wrong.id), /REFUND_INELIGIBLE/);
    await f.funding(o, o.cashAmount, f.actor.wallet, h(201));
    assert.equal(await f.state(o.id), 'BROKER_PENDING');
}));
test('PG expired inclusion held and refunded with independent finalized evidence, order closes', options, async () => scenario(async (f) => {
    const o = await f.order();
    const late = (BigInt(Math.floor(new Date(o.quoteExpiresAt).getTime() / 1000)) + 10n).toString();
    const funding = await f.funding(o, o.cashAmount, f.actor.wallet, h(200), late) as Record<string, any>;
    assert.equal(await f.state(o.id), 'FUNDED_QUOTE_EXPIRED');
    await f.service.requestRefund(funding.id);
    await f.worker.runOne();
    assert.equal(await f.state(o.id), 'FUNDED_QUOTE_EXPIRED');
    const call = f.signer.calls[0];
    f.rpc.confirmation(call, o.cashAmount, f.actor.wallet, 'REFUND', f.signer.receipts.get(call.operationId)!.txHash);
    await f.eligible();
    await f.worker.runOne();
    assert.equal(await f.state(o.id), 'REFUNDED');
    assert.equal((await f.repo.portfolio(f.actor.actorId)).pending.length, 0);
}));
test('PG timely included deposit remains eligible after finality delay; late observer time is irrelevant', options, async () => scenario(async (f) => {
    const o = await f.order();
    f.rpc.funding(o.orderKey, o.cashAmount);
    f.rpc.finalizedNumber = '1';
    assert.deepEqual(await f.service.observeFunding(h(200)), { status: 'FINALITY_PENDING' });
    assert.equal(await f.state(o.id), 'AWAITING_FUNDING');
    f.rpc.finalizedNumber = '100';
    await f.service.observeFunding(h(200));
    assert.equal(await f.state(o.id), 'BROKER_PENDING');
}));
test('PG under/over/unknown order/direct transfer retained in suspense; unidentified cannot refund', options, async () => scenario(async (f) => {
    for (const value of ['1', '999999999']) {
        const o = await f.order();
        const fact = await f.funding(o, value, f.actor.wallet, h(value === '1' ? 211 : 212)) as Record<string, any>;
        assert.equal(fact.status, 'SUSPENSE');
        assert.equal(await f.state(o.id), 'FUNDING_REVIEW_REQUIRED');
    }
    f.rpc.funding(h(999), '123', f.actor.wallet, h(213));
    const unknown = await f.service.observeFunding(h(213)) as Record<string, any>;
    assert.equal(unknown.reason, 'UNIDENTIFIED_ORDER');
    await assert.rejects(() => f.service.requestRefund(unknown.id), /REFUND_INELIGIBLE/);
    f.rpc.add({ hash: h(214), from: a(88), to: f.m.cashToken, input: '0x', value: '0' }, [eventLog(f.m.cashToken, 'Transfer', { from: a(88), to: f.m.fundingVault, value: 55n }, 0)]);
    const direct = await f.service.observeFunding(h(214)) as Record<string, any>[];
    assert.equal(direct[0].reason, 'UNATTRIBUTED_TRANSFER');
    await f.service.observeFunding(h(214));
    await assert.rejects(() => f.service.requestRefund(direct[0].id), /REFUND_INELIGIBLE/);
}));
test('PG completed purchase survives second distinct payment and its refund', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.complete(o);
    const second = await f.funding(o, '77', f.actor.wallet, h(250)) as Record<string, any>;
    assert.equal(second.reason, 'SECOND_PAYMENT');
    await f.service.requestRefund(second.id);
    await f.worker.runOne();
    const call = f.signer.calls[f.signer.calls.length - 1]!;
    f.rpc.confirmation(call, '77', f.actor.wallet, 'REFUND', f.signer.receipts.get(call.operationId)!.txHash);
    await f.eligible();
    await f.worker.runOne();
    assert.equal(await f.state(o.id), 'COMPLETED');
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings[0].quantity, o.quantity);
}));
test('PG unsupported partial broker result and forged mint evidence hold, never grant holdings', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    await new StocksWorker(f.service, { submit: async (req) => ({ ...req, outcome: 'PARTIAL', mode: 'MOCK_BROKER' }), lookup: async () => null }, f.signer).runOne();
    assert.equal(await f.state(o.id), 'REVIEW_REQUIRED');
    assert.equal(f.signer.calls.length, 0);
    const other = await f.order();
    await f.funding(other, other.cashAmount, f.actor.wallet, h(260));
    await f.worker.runOne();
    await f.worker.runOne();
    const call = f.signer.calls[0];
    f.rpc.confirmation(call, '1', f.actor.wallet, 'MINT', f.signer.receipts.get(call.operationId)!.txHash);
    await f.eligible();
    await f.worker.runOne();
    assert.equal(await f.state(other.id), 'REVIEW_REQUIRED');
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings.length, 0);
}));
test('PG journal pairs append-only, integral bounded amounts, order snapshots, stale version and atomic rollback', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    for (const sql of ['UPDATE arco_evm."StocksJournal" SET amount=2', 'DELETE FROM arco_evm."StocksJournal"'])
        await assert.rejects(() => f.pool.query(sql), /immutable/);
    await assert.rejects(() => f.pool.query('TRUNCATE arco_evm."StocksAudit"'), /immutable/);
    for (const value of ['0', '-1', '1.5', '1e40'])
        await assert.rejects(() => f.pool.query('INSERT INTO arco_evm."StocksJournal" (id,asset,debit,credit,amount,"deploymentDigest") VALUES ($1,\'x\',\'A\',\'B\',$2,$3)', [randomUUID(), value, f.repo.deploymentDigest]));
    await assert.rejects(() => f.pool.query('UPDATE arco_evm."StocksOrder" SET wallet=$1,version=version+1 WHERE id=$2', [a(88), o.id]), /immutable/);
    await assert.rejects(() => f.repo.tx(db => f.repo.state(db, o, 'BROKER_PENDING')), /STALE_ORDER_VERSION/);
    const entry = randomUUID();
    await assert.rejects(() => f.repo.tx(async (db) => { await f.repo.journal(db, entry, 'X', 'A', 'B', '10'); throw new Error('rollback'); }));
    assert.equal((await f.pool.query('SELECT id FROM arco_evm."StocksJournal" WHERE id=$1', [entry])).rows.length, 0);
}));
test('PG deployment reset cannot claim old intent or expose old holdings; reconciliation needs coverage and independent balances', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.complete(o);
    const fresh = testManifest();
    fresh.deploymentId = `RESET_${randomUUID()}`;
    fresh.networkInstance = `RESET_NETWORK_${randomUUID()}`;
    const repo = new StocksRepository(f.pool, manifestDigest(fresh));
    const rpc = new TestChain(fresh);
    const service = new StocksService(repo, fresh, new ReceiptVerifier(fresh, rpc), { manifestDigest: manifestDigest(fresh), contractPolicyVerified: true }, async () => false);
    assert.equal((await repo.portfolio(f.actor.actorId)).holdings.length, 0);
    const pending = await f.order();
    await f.funding(pending, pending.cashAmount, f.actor.wallet, h(280));
    assert.equal(await new StocksWorker(service, createDurableMockBroker(repo), f.signer).runOne(), false);
    assert.equal((await reconcileStocks(f.service)).status, 'UNAVAILABLE');
    const coverage = async () => ({ deploymentDigest: f.service.digest, throughBlock: '20', blockHash: h(20), observedAt: new Date().toISOString() });
    const mismatch = await reconcileStocks(f.service, coverage);
    assert.equal(mismatch.status, 'MISMATCH');
    f.rpc.cashBalance = (BigInt(o.cashAmount) + BigInt(pending.cashAmount)).toString();
    f.rpc.stockSupply = o.quantity;
    f.rpc.walletBalances[f.actor.wallet] = o.quantity;
    assert.equal((await reconcileStocks(f.service, coverage)).status, 'MATCHED_AT_CUTOFF');
}));
test('PG adversarial broker/signer mutations cannot change durable authorized quantity or call', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    const mutatingBroker = new StocksWorker(f.service, { submit: async (req) => { req.quantity = '1'; return { ...req, mode: 'MOCK_BROKER', outcome: 'FILLED' }; }, lookup: async () => null }, f.signer);
    await mutatingBroker.runOne();
    assert.equal(await f.state(o.id), 'BROKER_UNKNOWN');
    assert.equal(f.signer.calls.length, 0);
    const other = await f.order();
    await f.funding(other, other.cashAmount, f.actor.wallet, h(290));
    await f.worker.runOne();
    let mutations = 0;
    const mutatingSigner = new StocksWorker(f.service, f.broker, { submit: async (call) => { mutations++; call.to = a(999); throw new Error('unreachable'); }, lookup: async () => null });
    await mutatingSigner.runOne();
    assert.equal(mutations, 1);
    assert.equal(await f.state(other.id), 'MINT_UNKNOWN');
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings.length, 0);
}));
