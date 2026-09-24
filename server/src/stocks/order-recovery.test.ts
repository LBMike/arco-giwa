import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { recoverOrder } from './order-recovery.js';
import { StocksRepository } from './repository.js';
import { stocksPlugin } from './plugin.js';
import { StocksService } from './service.js';
import { ReceiptVerifier } from './chain.js';
import { manifestDigest, type Actor, type SqlPool } from './contracts.js';
import { ACTOR, TestChain, testManifest } from './test-fixtures.js';

function fixture() {
    const queries: { sql: string; params?: unknown[] }[] = [];
    let row: Record<string, unknown> | undefined = { id: 'order', quoteId: 'quote', state: 'AWAITING_FUNDING' };
    let failure = false;
    const pool: SqlPool = {
        connect: async () => { throw new Error('UNEXPECTED_CONNECTION'); },
        query: async (sql, params) => {
            queries.push({ sql, params });
            if (failure) throw new Error('private-database-password');
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        },
    };
    const manifest = testManifest();
    const repo = new StocksRepository(pool, manifestDigest(manifest));
    const service = new StocksService(repo, manifest, new ReceiptVerifier(manifest, new TestChain(manifest)), undefined, async () => { throw new Error('UNEXPECTED_PAUSE_CHECK'); });
    return { repo, service, queries, setRow: (value: typeof row) => { row = value; }, fail: () => { failure = true; } };
}

for (const side of ['BUY', 'SELL'] as const) {
    test(`${side} recovery uses one scoped SELECT without activation, binding, pause or RPC`, async () => {
        const f = fixture();
        const result = await (side === 'BUY' ? f.service : f.service.sell).recoverOrder(ACTOR, 'quote', 'retry-key');
        assert.equal(result.id, 'order');
        assert.equal(result.side, side);
        assert.equal(f.queries.length, 1);
        assert.match(f.queries[0].sql, /^SELECT \*/);
        assert.ok(!/UPDATE|INSERT|DELETE|FOR SHARE/.test(f.queries[0].sql));
        assert.deepEqual(f.queries[0].params, [ACTOR.actorId, ACTOR.wallet.toLowerCase(), f.repo.deploymentDigest, 'retry-key']);
        assert.ok(f.queries[0].sql.includes(side === 'BUY' ? '"StocksOrder"' : '"StocksSellOrder"'));
    });
    test(`${side} recovery authenticates and validates before lookup, distinguishes owned conflict`, async () => {
        const f = fixture();
        await assert.rejects(recoverOrder(f.repo, { ...ACTOR, verified: false } as unknown as Actor, side, 'quote', 'retry-key'), /UNAUTHORIZED/);
        for (const [q, key] of [['', 'retry-key'], ['q'.repeat(129), 'retry-key'], ['quote', 'short'], ['quote', "injection'key"], ['quote', 'k'.repeat(129)]]) {
            await assert.rejects(recoverOrder(f.repo, ACTOR, side, q, key), /INVALID_ORDER_REQUEST/);
        }
        assert.equal(f.queries.length, 0);
        await assert.rejects(recoverOrder(f.repo, ACTOR, side, 'different-quote', 'retry-key'), /IDEMPOTENCY_CONFLICT/);
        f.setRow(undefined);
        await assert.rejects(recoverOrder(f.repo, ACTOR, side, 'quote', 'retry-key'), /ORDER_NOT_FOUND/);
    });
    test(`${side} HTTP recovery is authenticated, strict, no-store and sanitizes failures`, async t => {
        const f = fixture(), app = Fastify();
        await app.register(stocksPlugin, { service: f.service, resolveActor: async r => r.headers.authorization === 'Bearer fixture' ? ACTOR : null });
        t.after(() => app.close());
        const url = `/api/v1/stocks/${side === 'BUY' ? 'orders' : 'sell-orders'}/recover`;
        const payload = { quoteId: 'quote', idempotencyKey: 'retry-key' }, headers = { authorization: 'Bearer fixture' };
        const unauth = await app.inject({ method: 'POST', url, payload });
        assert.equal(unauth.statusCode, 401);
        assert.equal(unauth.headers['cache-control'], 'no-store');
        const malformed = { method: 'POST' as const, url, payload: '{broken', headers: { 'content-type': 'application/json' } };
        assert.equal((await app.inject(malformed)).statusCode, 401);
        const invalidJson = await app.inject({ ...malformed, headers: { ...malformed.headers, ...headers } });
        assert.equal(invalidJson.statusCode, 400);
        assert.equal(invalidJson.json().error, 'INVALID_BODY');
        assert.equal(invalidJson.headers['cache-control'], 'no-store');
        for (const extra of [{ payload: { ...payload, wallet: ACTOR.wallet } }, { payload: { quoteId: 'quote' } }, { payload: [] }, { payload, url: `${url}?actorId=fake` }]) {
            const response = await app.inject({ method: 'POST', url, headers, ...extra });
            assert.equal(response.statusCode, 400);
            assert.equal(response.headers['cache-control'], 'no-store');
        }
        assert.equal(f.queries.length, 0);
        const ok = await app.inject({ method: 'POST', url, headers, payload });
        assert.equal(ok.statusCode, 200);
        assert.equal(ok.json().data.side, side);
        assert.equal(ok.json().profile, 'DEMO_TESTNET');
        assert.equal(ok.headers['cache-control'], 'no-store');
        assert.ok(Number.isFinite(Date.parse(ok.json().observedAt)));
        const conflict = await app.inject({ method: 'POST', url, headers, payload: { ...payload, quoteId: 'other' } });
        assert.equal(conflict.statusCode, 409);
        f.setRow(undefined);
        const missing = await app.inject({ method: 'POST', url, headers, payload });
        assert.equal(missing.statusCode, 404);
        assert.equal(missing.headers['cache-control'], 'no-store');
        f.fail();
        const failed = await app.inject({ method: 'POST', url, headers, payload });
        assert.equal(failed.statusCode, 500);
        assert.equal(failed.json().error, 'INTERNAL_ERROR');
        assert.equal(failed.headers['cache-control'], 'no-store');
        assert.ok(!failed.body.includes('private-database'));
    });
}
