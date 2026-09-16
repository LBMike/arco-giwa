import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MARKET_CONTEXT, type ChartRange } from './contracts.js';
import type { StocksMarketDataService } from './service.js';
import { RANGE_RULES } from './normalize.js';

export interface StocksMarketDataPluginOptions { service: StocksMarketDataService }
const ROOT = '/api/v1/stocks/market';
class InputError extends Error { constructor(readonly code: 'INVALID_QUERY' | 'UNKNOWN_SYMBOL', readonly status: number) { super(code); } }
export async function stocksMarketDataPlugin(app: FastifyInstance, { service }: StocksMarketDataPluginOptions): Promise<void> {
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof InputError ? error.status : 500).send({ ...MARKET_CONTEXT, error: error instanceof InputError ? error.code : 'MARKET_DATA_INTERNAL_ERROR' }));
  const query = (request: FastifyRequest, allowed: string[] = []) => {
    const q = request.query as Record<string, unknown>;
    if (!q || Object.keys(q).some(k => !allowed.includes(k))) throw new InputError('INVALID_QUERY', 400);
  };
  const symbol = (request: FastifyRequest): string => { const name = (request.params as { symbol: string }).symbol; if (!service.hasSymbol(name)) throw new InputError('UNKNOWN_SYMBOL', 404); return name; };
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); });
  app.get(`${ROOT}/catalog`, async r => { query(r); return service.catalog(); });
  app.get(`${ROOT}/quotes`, async r => { query(r); return service.quotes(); });
  app.get(`${ROOT}/:symbol/profile`, async r => { query(r); return service.profile(symbol(r)); });
  app.get(`${ROOT}/:symbol/chart`, async r => {
    query(r, ['range']); const range = (r.query as { range?: unknown }).range;
    if (typeof range !== 'string' || !Object.prototype.hasOwnProperty.call(RANGE_RULES, range)) throw new InputError('INVALID_QUERY', 400);
    return service.chart(symbol(r), range as ChartRange);
  });
  app.get(`${ROOT}/:symbol/logo`, async (r, reply) => {
    query(r); const result = await service.logo(symbol(r));
    if (!result.data) return reply.code(404).send(result);
    reply.header('Content-Security-Policy', "default-src 'none'");
    return reply.type(result.data.contentType).send(Buffer.from(result.data.bytes));
  });
}
