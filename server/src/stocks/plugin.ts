import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ensure, PROFILE, StocksError, validateActor, type Actor, type Operator } from './contracts.js';
import { reconcileStocks, type CoveragePort } from './reconciliation.js';
import { StocksService } from './service.js';
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
    app.setErrorHandler((e, _request, reply) => { if (e instanceof StocksError)
        return reply.code(e.status).send({ error: e.code, ...PROFILE }); app.log.error({ code: 'STOCKS_INTERNAL_ERROR' }); return reply.code(500).send({ error: 'INTERNAL_ERROR', ...PROFILE }); });
    app.get('/api/v1/stocks/catalog', async () => s.catalog());
    app.post('/api/v1/stocks/quotes', async (r) => { const a = await actor(r); const b = body(r.body, ['symbol', 'quantity']); ensure(typeof b.symbol === 'string', 'INVALID_SYMBOL'); return envelope(await s.quote(a, b.symbol, b.quantity)); });
    app.post('/api/v1/stocks/orders', async (r) => { const a = await actor(r); const b = body(r.body, ['quoteId', 'idempotencyKey']); ensure(typeof b.quoteId === 'string' && typeof b.idempotencyKey === 'string', 'INVALID_ORDER_REQUEST'); return envelope(await s.createOrder(a, b.quoteId, b.idempotencyKey)); });
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
}
