import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zeroAddress } from 'viem';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { manifestDigest, operationKey, type Actor, type SqlPool } from './contracts.js';
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
    const service = new StocksService(repo, m, new ReceiptVerifier(m, rpc), { manifestDigest: manifestDigest(m), contractPolicyVerified: true }, async () => paused, async () => true, async () => true);
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
        rpc.cashBalance = (BigInt(rpc.cashBalance) + BigInt(o.cashAmount)).toString();
        rpc.stockSupply = (BigInt(rpc.stockSupply) + BigInt(o.quantity)).toString();
        rpc.walletBalances[actor.wallet] = (BigInt(rpc.walletBalances[actor.wallet] ?? '0') + BigInt(o.quantity)).toString();
    };
    return { pool, m, repo, rpc, signer, service, broker, worker, actor, order, state, funding, eligible, complete, pause: (v: boolean) => { paused = v; } };
}
async function scenario(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    const f = await fixture();
    try {
        await work(f);
    }
    finally {
        await f.pool.end();
    }
}
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
test('PG actual child SIGKILL after durable broker acceptance recovers original operation without resubmission', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-broker-fixture.js', import.meta.url))], { env: { ...process.env, STOCKS_CRASH_MANIFEST: JSON.stringify(f.m) }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(await f.state(o.id), 'BROKER_PENDING');
    const before = (await f.pool.query('SELECT status FROM arco_evm."StocksOutbox" WHERE id=$1', [`broker:${o.id}`])).rows[0];
    assert.equal(before.status, 'STARTED');
    await f.eligible();
    await new StocksWorker(f.service, createDurableMockBroker(new StocksRepository(f.pool, f.repo.deploymentDigest)), f.signer).runOne();
    assert.equal(await f.state(o.id), 'MINT_QUEUED');
    assert.equal((await f.pool.query('SELECT COUNT(*)::text AS n FROM arco_evm."StocksProviderReceipt" WHERE id=$1', [`broker:${o.id}`])).rows[0].n, '1');
    assert.equal((await f.pool.query('SELECT COUNT(*)::text AS n FROM arco_evm."StocksOutbox" WHERE id=$1', [`mint:${o.id}`])).rows[0].n, '1');
}));
test('PG same cash movement cannot credit twice after attribution conflict; zero transfers ignored and direct cash mint held', options, async () => scenario(async (f) => {
    const o = await f.order();
    await f.funding(o);
    f.rpc.receipts.get(h(200))!.logs.shift();
    const conflict = await f.service.observeFunding(h(200)) as Record<string, any>[];
    assert.equal(conflict[0].conflict, 'REVIEW_REQUIRED');
    assert.equal(await f.state(o.id), 'REVIEW_REQUIRED');
    assert.equal(await f.worker.runOne(), false);
    assert.equal((await f.pool.query('SELECT COUNT(*)::text AS n FROM arco_evm."StocksFunding" WHERE "deploymentDigest"=$1', [f.repo.deploymentDigest])).rows[0].n, '1');
    assert.equal((await f.pool.query('SELECT COUNT(*)::text AS n FROM arco_evm."StocksJournal" WHERE "deploymentDigest"=$1', [f.repo.deploymentDigest])).rows[0].n, '1');
    f.rpc.add({ hash: h(299), from: f.actor.wallet, to: f.m.cashToken, input: '0x', value: '0' }, [eventLog(f.m.cashToken, 'Transfer', { from: f.actor.wallet, to: f.m.fundingVault, value: 0n }, 0), eventLog(f.m.cashToken, 'Transfer', { from: zeroAddress, to: f.m.fundingVault, value: 12n }, 1)]);
    const unallocated = await f.service.observeFunding(h(299)) as Record<string, any>[];
    assert.equal(unallocated.length, 1);
    assert.equal(unallocated[0].amount, '12');
    assert.equal(unallocated[0].payer, zeroAddress);
    await assert.rejects(() => f.service.requestRefund(unallocated[0].id), /REFUND_INELIGIBLE/);
}));
test('PG deterministic varied-order conservation property across permutation, replay and refunds', options, async () => scenario(async (f) => {
    // Independent business oracle, including prices/units written explicitly rather than calling amount helpers.
    const cases = [
        { quantity: '1', required: '120000000', paid: '120000000', units: '1000000000', bought: true },
        { quantity: '0.125', required: '15000000', paid: '15000000', units: '125000000', bought: true },
        { quantity: '2', required: '240000000', paid: '10000000', units: '2000000000', bought: false },
        { quantity: '3', required: '360000000', paid: '400000000', units: '3000000000', bought: false },
        { quantity: '0.5', required: '60000000', paid: '60000000', units: '500000000', bought: false },
    ];
    const orders = [];
    for (const entry of cases) {
        const order = await f.order(entry.quantity);
        assert.equal(order.cashAmount, entry.required);
        orders.push(order);
    }
    const operationExpectations = new Map<string, {
        kind: 'MINT' | 'REFUND';
        quantity: string;
    }>();
    for (const index of [3, 1, 4, 0, 2]) {
        const entry = cases[index];
        const order = orders[index];
        const timestamp = index === 4 ? (BigInt(Math.floor(new Date(order.quoteExpiresAt).getTime() / 1000)) + 10n).toString() : undefined;
        const funding = await f.funding(order, entry.paid, f.actor.wallet, h(400 + index), timestamp) as Record<string, any>;
        await f.service.observeFunding(h(400 + index));
        if (entry.bought)
            operationExpectations.set(`mint:${order.id}`, { kind: 'MINT', quantity: entry.units });
        else {
            const intent = await f.service.requestRefund(funding.id);
            operationExpectations.set(intent.operationId, { kind: 'REFUND', quantity: entry.paid });
        }
    }
    const confirmed = new Set<string>();
    for (let step = 0; step < 30; step++) {
        await f.eligible();
        if (!(await f.worker.runOne()))
            break;
        for (const call of f.signer.calls) {
            if (confirmed.has(call.operationId))
                continue;
            const expected = operationExpectations.get(call.operationId)!;
            assert.ok(expected);
            f.rpc.confirmation(call, expected.quantity, f.actor.wallet, expected.kind, f.signer.receipts.get(call.operationId)!.txHash);
            confirmed.add(call.operationId);
        }
    }
    assert.equal(confirmed.size, 5);
    const cash = (await f.pool.query(`SELECT SUM(CASE WHEN debit='CASH_VAULT' THEN amount WHEN credit='CASH_VAULT' THEN -amount ELSE 0 END)::text AS cash FROM arco_evm."StocksJournal" WHERE "deploymentDigest"=$1 AND asset=$2`, [f.repo.deploymentDigest, f.m.cashToken])).rows[0].cash;
    assert.equal(cash, '135000000');
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings[0].quantity, '1125000000');
    assert.equal((await f.repo.portfolio(f.actor.actorId)).pending.length, 0);
    for (let index = 0; index < cases.length; index++)
        assert.equal(await f.state(orders[index].id), cases[index].bought ? 'COMPLETED' : 'REFUNDED');
}));
test('PG already-expired immutable quote cannot create an order', options, async () => scenario(async (f) => {
    const id = randomUUID();
    await f.pool.query(`INSERT INTO arco_evm."StocksQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES ($1,$2,$3,'NVDA',1000000000,120000000,$4,clock_timestamp()-interval '1 second')`, [id, f.actor.actorId, f.actor.wallet, f.service.digest]);
    await assert.rejects(() => f.service.createOrder(f.actor, id, 'expired-quote-key'), /QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED/);
    assert.equal((await f.repo.scopedOrders(f.actor.actorId)).length, 0);
}));
async function sell(f: Awaited<ReturnType<typeof fixture>>, quantity = '1'): Promise<Record<string, any>> {
    const quote = await f.service.sell.quote(f.actor, 'NVDA', quantity);
    return f.service.sell.createOrder(f.actor, quote.id, `sell:${randomUUID()}`);
}
async function escrow(f: Awaited<ReturnType<typeof fixture>>, order: Record<string, any>, quantity = order.quantity, payer = f.actor.wallet, txHash = h(300), timestamp?: string): Promise<Record<string, any>> {
    const raw = f.rpc.escrow(order.orderKey, quantity, payer, txHash, timestamp);
    const fact = await f.service.sell.observeEscrow(raw.txHash) as Record<string, any>;
    return { ...fact, escrowId: raw.escrowId };
}
async function finishSell(f: Awaited<ReturnType<typeof fixture>>, order: Record<string, any>, fact: Record<string, any>, kind: 'REDEEM' | 'RETURN' = 'REDEEM') {
    await f.worker.runOne();
    const call = f.signer.calls[f.signer.calls.length - 1];
    const receipt = f.signer.receipts.get(call.operationId)!;
    f.rpc.redeem(call, fact.escrowId, fact.quantity, kind === 'REDEEM' ? order.cashAmount : '0', fact.payer, kind, receipt.txHash);
    await f.eligible();
    await f.worker.runOne();
}
test('SELL PG exact buy/escrow/redeem conserves wallet, escrow, supply and cash; replay grants nothing', options, async () => scenario(async (f) => {
    await f.complete(await f.order('2'));
    const order = await sell(f);
    const fact = await escrow(f, order);
    const held = (await f.repo.portfolio(f.actor.actorId)).holdings[0];
    assert.equal(held.walletQuantity, '1000000000');
    assert.equal(held.escrowedQuantity, '1000000000');
    assert.equal(held.quantity, '2000000000');
    assert.equal(held.reservedQuantity, '0');
    await f.worker.runOne();
    await finishSell(f, order, fact);
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'COMPLETED');
    const p = (await f.repo.portfolio(f.actor.actorId)).holdings[0];
    assert.equal(p.quantity, '1000000000');
    assert.equal(p.escrowedQuantity, '0');
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).cashBalance, '120000000');
    await f.service.sell.observeEscrow(h(300));
    assert.equal(await f.worker.runOne(), false);
    assert.equal(await f.repo.isTransactionProjected(f.signer.calls.length ? f.signer.receipts.get(f.signer.calls[f.signer.calls.length - 1].operationId)!.txHash : h(999)), true);
}));
test('SELL PG concurrent reservations cannot oversell and actor/idempotency/floor guards hold', options, async () => scenario(async (f) => {
    await f.complete(await f.order('1'));
    const quotes = await Promise.all([f.service.sell.quote(f.actor, 'NVDA', '0.75'), f.service.sell.quote(f.actor, 'NVDA', '0.75')]);
    const results = await Promise.allSettled(quotes.map((q, i) => f.service.sell.createOrder(f.actor, q.id, `concurrent-${i}`)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    const accepted = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Record<string, any>>;
    const row = accepted.value;
    assert.equal((await f.service.sell.createOrder(f.actor, row.quoteId, row.idempotencyKey)).id, row.id);
    await assert.rejects(() => f.service.sell.createOrder({ ...f.actor, wallet: a(66) }, row.quoteId, 'foreign-key'), /QUOTE_NOT_FOUND/);
    await assert.rejects(() => f.service.sell.quote(f.actor, 'NVDA', '0.000000001'), /ZERO_SELL_PAYOUT/);
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings[0].availableQuantity, '250000000');
}));
test('SELL PG liquidity excludes suspense, unfinished buys and previous sell claims before any broker dispatch', options, async () => scenario(async (f) => {
    await f.complete(await f.order('3'));
    // External chain liquidity is less than recorded cash; two sells must compete for one payout.
    f.rpc.cashBalance = '120000000';
    const one = await sell(f);
    const two = await sell(f);
    f.rpc.escrow(one.orderKey, one.quantity, f.actor.wallet, h(310));
    f.rpc.escrow(two.orderKey, two.quantity, f.actor.wallet, h(311));
    await Promise.all([f.service.sell.observeEscrow(h(310)), f.service.sell.observeEscrow(h(311))]);
    const states = (await f.repo.sellOrders(f.actor.actorId)).map(r => r.state);
    assert.equal(states.filter(s => s === 'SELL_BROKER_PENDING').length, 1);
    assert.equal(states.filter(s => s === 'LIQUIDITY_PENDING').length, 1);
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).sellReserved, '120000000');
    const before = (await f.pool.query(`SELECT COUNT(*)::text AS n FROM arco_evm."StocksProviderReceipt" WHERE "deploymentDigest"=$1`, [f.service.digest])).rows[0].n;
    assert.equal(before, '1');
}));
test('SELL PG rejected broker returns exact escrow; partial and unknown keep custody and cash held', options, async () => scenario(async (f) => {
    await f.complete(await f.order('3'));
    const order = await sell(f);
    const fact = await escrow(f, order);
    const rejected = new StocksWorker(f.service, { submit: async (req) => ({ ...req, outcome: 'REJECTED', quantity: '0', cashAmount: '0', mode: 'MOCK_BROKER' }), lookup: async () => null }, f.signer);
    await rejected.runOne();
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).sellReserved, '120000000');
    await finishSell(f, order, fact, 'RETURN');
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'RETURNED');
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).sellReserved, '0');
    const partial = await sell(f);
    await escrow(f, partial, partial.quantity, f.actor.wallet, h(320));
    await new StocksWorker(f.service, { submit: async (req) => ({ ...req, outcome: 'PARTIAL', quantity: '500000000', cashAmount: '60000000', mode: 'MOCK_BROKER' }), lookup: async () => null }, f.signer).runOne();
    assert.equal((await f.repo.sellOrders(f.actor.actorId, partial.id))[0].state, 'SELL_PARTIAL_HELD');
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).sellReserved, '120000000');
    await assert.rejects(async () => f.service.sell.requestReturn((await f.pool.query(`SELECT id FROM arco_evm."StocksCustody" WHERE "orderId"=$1`, [partial.id])).rows[0].id), /ESCROW_RETURN_INELIGIBLE/);
}));
test('SELL PG wrong wallet cannot poison owner; late and mismatched escrow remain returnable custody', options, async () => scenario(async (f) => {
    await f.complete(await f.order('3'));
    const order = await sell(f);
    const wrong = await escrow(f, order, '1000000000', a(88), h(330));
    assert.equal(wrong.reason, 'WRONG_WALLET');
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'AWAITING_ESCROW');
    await f.service.sell.requestReturn(wrong.id);
    await finishSell(f, order, wrong, 'RETURN');
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'AWAITING_ESCROW');
    const late = (BigInt(Math.floor(new Date(order.quoteExpiresAt).getTime() / 1000)) + 10n).toString();
    const fact = await escrow(f, order, order.quantity, f.actor.wallet, h(331), late);
    assert.equal(fact.reason, 'QUOTE_EXPIRED');
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'ESCROW_REVIEW_REQUIRED');
    await f.service.sell.requestReturn(fact.id);
    await finishSell(f, order, fact, 'RETURN');
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'RETURNED');
}));
test('SELL PG process crash after mock sale acceptance recovers one redemption intent; lost signer ack never resubmits', options, async () => scenario(async (f) => {
    await f.complete(await f.order('2'));
    const order = await sell(f);
    const fact = await escrow(f, order);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-broker-fixture.js', import.meta.url))], { env: { ...process.env, STOCKS_CRASH_MANIFEST: JSON.stringify(f.m) }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    await f.eligible();
    await f.worker.runOne();
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'REDEEM_QUEUED');
    const previous = f.signer.calls.length;
    f.signer.throwAfterSubmit = true;
    await f.worker.runOne();
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'SETTLEMENT_UNKNOWN');
    const call = f.signer.calls[f.signer.calls.length - 1];
    f.rpc.redeem(call, fact.escrowId, fact.quantity, order.cashAmount, f.actor.wallet, 'REDEEM', f.signer.receipts.get(call.operationId)!.txHash);
    f.pause(true);
    await f.eligible();
    await f.worker.runOne();
    assert.equal(f.signer.calls.length, previous + 1);
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'COMPLETED');
}));
test('SELL PG malformed/reverted redemption cannot burn projection or consume payout reservation', options, async () => scenario(async (f) => {
    await f.complete(await f.order('2'));
    const order = await sell(f);
    const fact = await escrow(f, order);
    await f.worker.runOne();
    await f.worker.runOne();
    const call = f.signer.calls[f.signer.calls.length - 1];
    const hash = f.signer.receipts.get(call.operationId)!.txHash;
    f.rpc.redeem(call, fact.escrowId, fact.quantity, '1', f.actor.wallet, 'REDEEM', hash);
    await f.eligible();
    await f.worker.runOne();
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'REVIEW_REQUIRED');
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings[0].escrowedQuantity, '1000000000');
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).sellReserved, '120000000');
}));
test('SELL PG real suspense and unfinished BUY cash are excluded even when chain balance is ample', options, async () => scenario(async (f) => {
    await f.complete(await f.order('1'));
    const pending = await f.order('2');
    await f.funding(pending, pending.cashAmount, f.actor.wallet, h(350));
    const suspicious = await f.order('1');
    await f.funding(suspicious, '500000000', f.actor.wallet, h(351));
    f.rpc.cashBalance = '860000000';
    const liquidity = await f.repo.liquidity(f.pool, f.m.cashToken);
    assert.equal(liquidity.cashBalance, '860000000');
    assert.equal(liquidity.liabilities, '740000000');
    const order = await sell(f);
    await escrow(f, order, order.quantity, f.actor.wallet, h(352));
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).sellReserved, '120000000');
    assert.equal((await f.repo.sellOrders(f.actor.actorId, order.id))[0].state, 'SELL_BROKER_PENDING');
}));
test('SELL PG stale high chain snapshot cannot reuse cash consumed after snapshot before liquidity lock', options, async () => scenario(async (f) => {
    await f.complete(await f.order('2'));
    const first = await sell(f);
    const second = await sell(f);
    f.rpc.cashBalance = '240000000';
    const fact = await escrow(f, first, first.quantity, f.actor.wallet, h(360));
    await f.worker.runOne();
    await f.worker.runOne();
    const call = f.signer.calls[f.signer.calls.length - 1];
    const tx = f.signer.receipts.get(call.operationId)!.txHash;
    f.rpc.redeem(call, fact.escrowId, fact.quantity, first.cashAmount, f.actor.wallet, 'REDEEM', tx);
    // Resolve first payout between the second snapshot and its atomic liquidity claim.
    const original = f.service.verifier.latestSnapshot.bind(f.service.verifier);
    let interleaved = false;
    f.service.verifier.latestSnapshot = async () => { const snapshot = await original(); if (!interleaved) {
        interleaved = true;
        await f.eligible();
        await f.worker.runOne();
    } return snapshot; };
    const secondFact = await escrow(f, second, second.quantity, f.actor.wallet, h(361));
    assert.equal(secondFact.reason, 'EXACT_ESCROW');
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).cashBalance, '120000000');
    assert.equal((await f.repo.liquidity(f.pool, f.m.cashToken)).sellReserved, '120000000');
    assert.equal((await f.repo.sellOrders(f.actor.actorId, first.id))[0].state, 'COMPLETED');
}));
test('SELL PG same vault cannot activate two deployment digests and cross-mix liabilities', options, async () => scenario(async (f) => {
    await f.complete(await f.order());
    const changed = { ...f.m, deploymentId: 'DIFFERENT_MANIFEST_SAME_VAULT' };
    const repo = new StocksRepository(f.pool, manifestDigest(changed));
    const service = new StocksService(repo, changed, new ReceiptVerifier(changed, new TestChain(changed)), { manifestDigest: manifestDigest(changed), contractPolicyVerified: true }, async () => false);
    await assert.rejects(() => service.quote(f.actor, 'NVDA', '1'), /VAULT_ALREADY_BOUND_TO_OTHER_DEPLOYMENT/);
}));
test('SELL PG escrow/supply/cash reconcile at one cutoff after finalized atomic redemption', options, async () => scenario(async (f) => {
    await f.complete(await f.order('2'));
    const order = await sell(f);
    const fact = await escrow(f, order);
    await f.worker.runOne();
    await finishSell(f, order, fact);
    f.rpc.cashBalance = '120000000';
    f.rpc.stockSupply = '1000000000';
    f.rpc.walletBalances[f.actor.wallet] = '1000000000';
    f.rpc.walletBalances[f.m.redemptionEscrow] = '0';
    const coverage = async () => ({ deploymentDigest: f.service.digest, throughBlock: '40', blockHash: h(40), observedAt: new Date().toISOString() });
    assert.equal((await reconcileStocks(f.service, coverage)).status, 'MATCHED_AT_CUTOFF');
    f.rpc.walletBalances[f.m.redemptionEscrow] = '1';
    assert.equal((await reconcileStocks(f.service, coverage)).status, 'MISMATCH');
}));
test('SELL PG expired reservation release needs finalized observer coverage; later escrow is still held for return', options, async () => scenario(async (f) => {
    await f.complete(await f.order('2'));
    const id = randomUUID();
    const quote = randomUUID();
    const key = operationKey(`expire:${id}`);
    await f.pool.query(`INSERT INTO arco_evm."StocksSellQuote" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") VALUES($1,$2,$3,'NVDA',1000000000,120000000,$4,clock_timestamp()-interval '10 seconds')`, [quote, f.actor.actorId, f.actor.wallet, f.service.digest]);
    const order = (await f.pool.query(`INSERT INTO arco_evm."StocksSellOrder" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt") VALUES($1,$2,$3,$4,$5,'NVDA',1000000000,120000000,'expiry-test-key',$6,$7,clock_timestamp()-interval '10 seconds') RETURNING *`, [id, key, quote, f.actor.actorId, f.actor.wallet, f.m.deploymentId, f.service.digest])).rows[0];
    await f.pool.query(`INSERT INTO arco_evm."StocksQuantityReservation" ("orderId","deploymentDigest",wallet,quantity,status) VALUES($1,$2,$3,1000000000,'ACTIVE')`, [id, f.service.digest, f.actor.wallet]);
    assert.equal(await f.service.sell.expireReservations(), 0);
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings[0].reservedQuantity, '1000000000');
    await f.pool.query('INSERT INTO arco_evm."StocksObserverCursor" ("deploymentDigest","blockNumber","blockHash") VALUES($1,100,$2)', [f.service.digest, h(100)]);
    assert.equal(await f.service.sell.expireReservations(), 0);
    await f.pool.query('UPDATE arco_evm."StocksObserverCursor" SET version=1 WHERE "deploymentDigest"=$1',[f.service.digest]);
    assert.equal(await f.service.sell.expireReservations(), 1);
    assert.equal((await f.repo.portfolio(f.actor.actorId)).holdings[0].availableQuantity, '2000000000');
    f.rpc.escrow(order.orderKey, order.quantity, f.actor.wallet, h(370));
    const receipt = f.rpc.receipts.get(h(370))!;
    receipt.blockNumber = '110';
    receipt.blockHash = h(110);
    f.rpc.blocks.set('110', { number: '110', hash: h(110), timestamp: Math.floor(Date.now() / 1000).toString() });
    f.rpc.finalizedNumber = '110';
    const fact = await f.service.sell.observeEscrow(h(370)) as Record<string, any>;
    assert.equal(fact.reason, 'QUOTE_EXPIRED');
    assert.equal(fact.status, 'HELD');
    assert.equal((await f.repo.sellOrders(f.actor.actorId, id))[0].state, 'ESCROW_REVIEW_REQUIRED');
}));
