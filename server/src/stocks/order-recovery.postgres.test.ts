import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { enabled, fixture } from '../stocks-submissions/test-fixtures.js';
import { stocksPlugin } from './plugin.js';
import { recoverOrder } from './order-recovery.js';
import { StocksRepository } from './repository.js';
import { a } from './test-fixtures.js';
const options = { skip: !enabled };
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function prepare(f: Fixture, side: 'BUY' | 'SELL', short = false) {
    if (side === 'SELL') await f.pool.query('INSERT INTO arco_evm."StocksQuantityMovement" (id,"deploymentDigest",wallet,"walletDelta","escrowDelta","supplyDelta","blockNumber","blockHash","txHash") VALUES($1,$2,$3,1000000000,0,1000000000,1,\'fixture-block\',\'fixture-tx\')', [randomUUID(), f.stocks.digest, f.actor.wallet]);
    const service = side === 'BUY' ? f.stocks : f.stocks.sell;
    let quote = await service.quote(f.actor, 'NVDA', '1');
    if (short) {
        const table = side === 'BUY' ? 'StocksQuote' : 'StocksSellQuote';
        quote = (await f.pool.query(`INSERT INTO arco_evm."${table}" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt") SELECT $2,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest",clock_timestamp()+interval '1500 milliseconds' FROM arco_evm."${table}" WHERE id=$1 RETURNING *`, [quote.id, randomUUID()])).rows[0];
    }
    return { service, quote, key: `recovery:${randomUUID()}` };
}
async function counts(f: Fixture) {
    return (await f.pool.query(`SELECT
      (SELECT count(*) FROM arco_evm."StocksOrder") AS buys,
      (SELECT count(*) FROM arco_evm."StocksSellOrder") AS sells,
      (SELECT count(*) FROM arco_evm."StocksAudit") AS audit,
      (SELECT count(*) FROM arco_evm."StocksQuantityReservation") AS reservations,
      (SELECT count(*) FROM arco_evm."StocksWalletSubmissionEnrollment") AS enrollment,
      (SELECT count(*) FROM arco_evm."StocksWalletSubmission") AS submissions,
      (SELECT count(*) FROM arco_evm."StocksLiquidityBinding") AS bindings`)).rows[0];
}
for (const side of ['BUY', 'SELL'] as const) {
    test(`real PG ${side}: lost creation response, concurrent retries, paused/expired HTTP recovery leave one order`, options, async t => {
        const f = await fixture(); t.after(() => f.pool.end());
        const { service, quote, key } = await prepare(f, side, true);
        const orders = await Promise.all(Array.from({ length: 8 }, () => service.createOrder(f.actor, quote.id, key)));
        assert.equal(new Set(orders.map(o => o.id)).size, 1);
        const table = side === 'BUY' ? 'StocksOrder' : 'StocksSellOrder';
        await new Promise(r => setTimeout(r, Math.max(0, new Date(quote.expiresAt).getTime() - Date.now() + 50)));
        assert.equal((await f.pool.query(`SELECT "quoteExpiresAt"<clock_timestamp() AS expired FROM arco_evm."${table}" WHERE id=$1`, [orders[0].id])).rows[0].expired, true);
        assert.equal((await f.pool.query(`SELECT count(*) FROM arco_evm."${table}" WHERE "actorId"=$1 AND "idempotencyKey"=$2`, [f.actor.actorId, key])).rows[0].count, '1');
        f.pause(true);
        await assert.rejects(service.createOrder(f.actor, quote.id, key), /STOCKS_PAUSED/);
        const before = await counts(f), app = Fastify();
        await app.register(stocksPlugin, { service: f.stocks, resolveActor: async () => f.actor }); t.after(() => app.close());
        const recovered = await app.inject({ method: 'POST', url: `/api/v1/stocks/${side === 'BUY' ? 'orders' : 'sell-orders'}/recover`, payload: { quoteId: quote.id, idempotencyKey: key } });
        assert.equal(recovered.statusCode, 200);
        assert.equal(recovered.json().data.id, orders[0].id);
        assert.equal(recovered.json().data.side, side);
        assert.equal(recovered.headers['cache-control'], 'no-store');
        assert.deepEqual(await counts(f), before);
        if (side === 'SELL') assert.equal((await f.pool.query('SELECT count(*) FROM arco_evm."StocksQuantityReservation" WHERE "orderId"=$1', [orders[0].id])).rows[0].count, '1');
    });
    test(`real PG ${side}: recovery scopes actor, wallet, deployment, side and quote`, options, async t => {
        const f = await fixture(); t.after(() => f.pool.end());
        const row = await f.order(side), service = side === 'BUY' ? f.stocks : f.stocks.sell;
        const before = await counts(f);
        await assert.rejects(service.recoverOrder({ ...f.actor, actorId: 'foreign' }, row.quoteId, row.idempotencyKey), /ORDER_NOT_FOUND/);
        await assert.rejects(service.recoverOrder({ ...f.actor, wallet: a(999) }, row.quoteId, row.idempotencyKey), /ORDER_NOT_FOUND/);
        await assert.rejects(recoverOrder(new StocksRepository(f.pool, 'other-deployment'), f.actor, side, row.quoteId, row.idempotencyKey), /ORDER_NOT_FOUND/);
        await assert.rejects(recoverOrder(f.repo, f.actor, side === 'BUY' ? 'SELL' : 'BUY', row.quoteId, row.idempotencyKey), /ORDER_NOT_FOUND/);
        await assert.rejects(service.recoverOrder(f.actor, randomUUID(), row.idempotencyKey), /IDEMPOTENCY_CONFLICT/);
        await assert.rejects(service.recoverOrder(f.actor, row.quoteId, `missing:${randomUUID()}`), /ORDER_NOT_FOUND/);
        assert.deepEqual(await counts(f), before);
    });
    test(`real PG ${side}: uncommitted creation is not found, rollback stays missing and same-key retry recovers`, options, async t => {
        const f = await fixture(); t.after(() => f.pool.end());
        const { service, quote, key } = await prepare(f, side);
        let reached!: () => void, resume!: () => void;
        const waiting = new Promise<void>(r => { reached = r; }), gate = new Promise<void>(r => { resume = r; });
        const audit = f.repo.audit.bind(f.repo);
        f.repo.audit = async (db, subject, action, detail) => { await audit(db, subject, action, detail); reached(); await gate; throw new Error('SIMULATED_COMMIT_FAILURE'); };
        const pending = assert.rejects(service.createOrder(f.actor, quote.id, key), /SIMULATED_COMMIT_FAILURE/);
        await waiting;
        try { await assert.rejects(service.recoverOrder(f.actor, quote.id, key), /ORDER_NOT_FOUND/); }
        finally { resume(); }
        await pending;
        f.repo.audit = audit;
        await assert.rejects(service.recoverOrder(f.actor, quote.id, key), /ORDER_NOT_FOUND/);
        const order = await service.createOrder(f.actor, quote.id, key);
        assert.equal((await service.recoverOrder(f.actor, quote.id, key)).id, order.id);
        if (side === 'SELL') assert.equal((await f.pool.query('SELECT count(*) FROM arco_evm."StocksQuantityReservation" WHERE "orderId"=$1', [order.id])).rows[0].count, '1');
    });
}
