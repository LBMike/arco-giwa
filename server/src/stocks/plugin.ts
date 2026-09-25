import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ensure, PROFILE, StocksError, validateActor, type Actor, type Operator } from './contracts.js';
import { reconcileStocks, type CoveragePort } from './reconciliation.js';
import { StocksService } from './service.js';
import { parseHeldQuery, readHeldPayments } from './held.js';
export type StocksPluginOptions = {
    service: StocksService;
    resolveActor?: (request: FastifyRequest) => Promise<Actor | null>;
    resolveOperator?: (request: FastifyRequest) => Promise<Operator | null>;
    reconciliationCoverage?: CoveragePort;
};
function body(input: unknown, keys: string[]): Record<string, unknown> {
    ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_BODY');
    const record = input as Record<string, unknown>;
    ensure(Object.keys(record).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(record, k)), 'UNEXPECTED_FIELDS');
    return record;
}
export async function stocksPlugin(app: FastifyInstance, options: StocksPluginOptions): Promise<void> {
    const s = options.service;
    const actor = async (r: FastifyRequest) => { const a = await options.resolveActor?.(r); ensure(a, 'UNAUTHORIZED', 401); validateActor(a); return a; };
    const operator = async (r: FastifyRequest) => { const op = await options.resolveOperator?.(r); ensure(op && typeof op.operatorId === 'string' && op.operatorId.length > 0 && op.permissions.includes('stocks:read'), 'OPERATOR_FORBIDDEN', 403); return op; };
    const envelope = (data: unknown) => ({ ...PROFILE, observedAt: new Date().toISOString(), data });
    app.setErrorHandler((e, _request, reply) => {
        if (e instanceof StocksError)
            return reply.code(e.status).send({ error: e.code, ...PROFILE });
        app.log.error({ code: 'STOCKS_INTERNAL_ERROR' });
        return reply.code(500).send({ error: 'INTERNAL_ERROR', ...PROFILE });
    });
    app.get('/api/v1/stocks/catalog', async () => s.currentCatalog());
    // Public: a direct order's progress. The key is the paying wallet's own random value; no session is involved.
    app.get<{
        Params: {
            orderKey: string;
        };
    }>('/api/v1/stocks/direct/:orderKey', async (r) => envelope(await s.directOrder(r.params.orderKey)));
    // Public, like a wallet's product activity: its Stocks trades and their GIWA transactions.
    app.get<{
        Params: {
            wallet: string;
        };
    }>('/api/v1/stocks/activity/:wallet', async (r) => envelope(await s.walletActivity(r.params.wallet)));
    const recoveryActors = new WeakMap<FastifyRequest, Actor>();
    for (const [path, service] of [['orders', s], ['sell-orders', s.sell]] as const) {
        app.post(`/api/v1/stocks/${path}/recover`, {
            onRequest: async (r, reply) => {
                reply.header('Cache-Control', 'no-store');
                recoveryActors.set(r, await actor(r));
            },
            errorHandler: (error, _r, reply) => {
                if (error instanceof StocksError) return reply.code(error.status).send({ error: error.code, ...PROFILE });
                if (error.statusCode === 400) return reply.code(400).send({ error: 'INVALID_BODY', ...PROFILE });
                if (error.statusCode === 413) return reply.code(413).send({ error: 'BODY_TOO_LARGE', ...PROFILE });
                if (error.statusCode === 415) return reply.code(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE', ...PROFILE });
                app.log.error({ code: 'STOCKS_RECOVERY_INTERNAL_ERROR' });
                return reply.code(500).send({ error: 'INTERNAL_ERROR', ...PROFILE });
            },
        }, async (r) => {
            const a = recoveryActors.get(r);
            ensure(a, 'UNAUTHORIZED', 401);
            ensure(Object.keys(r.query as object).length === 0, 'UNEXPECTED_FIELDS');
            const b = body(r.body, ['quoteId', 'idempotencyKey']);
            ensure(typeof b.quoteId === 'string' && typeof b.idempotencyKey === 'string', 'INVALID_ORDER_REQUEST');
            return envelope(await service.recoverOrder(a, b.quoteId, b.idempotencyKey));
        });
    }
    // A Buy is quoted for an NVDA quantity, or for an exact tUSDC amount (the NVDA it buys at the current price).
    app.post('/api/v1/stocks/quotes', async (r) => {
        const a = await actor(r);
        const byCash = r.body !== null && typeof r.body === 'object' && Object.prototype.hasOwnProperty.call(r.body, 'cashAmount');
        const b = body(r.body, ['symbol', byCash ? 'cashAmount' : 'quantity']);
        ensure(typeof b.symbol === 'string', 'INVALID_SYMBOL');
        return envelope(await (byCash ? s.quoteForCash(a, b.symbol, b.cashAmount) : s.quote(a, b.symbol, b.quantity)));
    });
    app.post('/api/v1/stocks/orders', async (r) => { const a = await actor(r); const b = body(r.body, ['quoteId', 'idempotencyKey']); ensure(typeof b.quoteId === 'string' && typeof b.idempotencyKey === 'string', 'INVALID_ORDER_REQUEST'); return envelope(await s.createOrder(a, b.quoteId, b.idempotencyKey)); });
    app.post('/api/v1/stocks/sell-quotes', async (r) => { const a = await actor(r); const b = body(r.body, ['symbol', 'quantity']); ensure(typeof b.symbol === 'string', 'INVALID_SYMBOL'); return envelope(await s.sell.quote(a, b.symbol, b.quantity)); });
    app.post('/api/v1/stocks/sell-orders', async (r) => { const a = await actor(r); const b = body(r.body, ['quoteId', 'idempotencyKey']); ensure(typeof b.quoteId === 'string' && typeof b.idempotencyKey === 'string', 'INVALID_ORDER_REQUEST'); return envelope(await s.sell.createOrder(a, b.quoteId, b.idempotencyKey)); });
    app.get('/api/v1/stocks/sell-orders', async (r) => envelope(await s.repo.sellOrders((await actor(r)).actorId)));
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/v1/stocks/sell-orders/:id', async (r) => { const row = (await s.repo.sellOrders((await actor(r)).actorId, r.params.id))[0]; ensure(row, 'ORDER_NOT_FOUND', 404); return envelope(row); });
    app.get('/api/v1/stocks/orders', async (r) => envelope(await s.repo.scopedOrders((await actor(r)).actorId)));
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/v1/stocks/orders/:id', async (r) => { const rows = await s.repo.scopedOrders((await actor(r)).actorId, r.params.id); ensure(rows[0], 'ORDER_NOT_FOUND', 404); return envelope(rows[0]); });
    app.get('/api/v1/stocks/portfolio', async (r) => envelope(await s.repo.portfolio((await actor(r)).actorId)));
    for (const kind of ['overview', 'orders', 'reconciliations', 'audit'] as const)
        app.get(`/api/v1/admin/stocks/${kind}`, async (r) => { await operator(r); return envelope(kind === 'reconciliations' ? await reconcileStocks(s, options.reconciliationCoverage) : await s.repo.admin(kind)); });
    app.get<{
        Params: {
            id: string;
        };
    }>('/api/v1/admin/stocks/orders/:id', async (r) => { await operator(r); const detail = await s.repo.adminOrder(r.params.id); ensure(detail, 'ORDER_NOT_FOUND', 404); return envelope(detail); });
    // Read-only: payments and escrows the observer held without creating an order, newest first, one page per call.
    app.get('/api/v1/admin/stocks/held', async (r) => { await operator(r); return envelope(await readHeldPayments(s.repo, parseHeldQuery(r.query))); });
}
