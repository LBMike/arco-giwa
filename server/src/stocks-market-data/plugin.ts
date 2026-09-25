import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MARKET_CONTEXT, type ChartRange } from './contracts.js';
import type { StocksMarketDataService } from './service.js';
import { RANGE_RULES } from './normalize.js';
import type { NvdaLiveSnapshotOptions } from './live-snapshot.js';
import { createNvdaLiveReader } from './live-reader.js';
import { createSnapshotStreamHub } from './live-stream.js';

export interface StocksMarketDataPluginOptions {
  service: StocksMarketDataService;
  marketClock?: NvdaLiveSnapshotOptions['marketClock'];
  executionCatalog?: NvdaLiveSnapshotOptions['executionCatalog'];
}
const ROOT = '/api/v1/stocks/market';
class InputError extends Error { constructor(readonly code: 'INVALID_QUERY' | 'UNKNOWN_SYMBOL', readonly status: number) { super(code); } }
export async function stocksMarketDataPlugin(app: FastifyInstance, { service, marketClock, executionCatalog }: StocksMarketDataPluginOptions): Promise<void> {
  const { provider, marketFeed } = service.catalog();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof InputError ? error.status : 500).send({ ...MARKET_CONTEXT, provider, ...(marketFeed ? { marketFeed } : {}), error: error instanceof InputError ? error.code : 'MARKET_DATA_INTERNAL_ERROR' }));
  const query = (request: FastifyRequest, allowed: string[] = []) => {
    const q = request.query as Record<string, unknown>;
    if (!q || Object.keys(q).some(k => !allowed.includes(k))) throw new InputError('INVALID_QUERY', 400);
  };
  const symbol = (request: FastifyRequest): string => { const name = (request.params as { symbol: string }).symbol; if (!service.hasSymbol(name)) throw new InputError('UNKNOWN_SYMBOL', 404); return name; };
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); });
  app.get(`${ROOT}/catalog`, async r => { query(r); return service.catalog(); });
  app.get(`${ROOT}/quotes`, async r => { query(r); return service.quotes(); });
  const live = createNvdaLiveReader({ marketData: service, marketClock, executionCatalog });
  // Leave headroom in the default five-request/minute provider budget while
  // the existing Stocks/Home screens still poll the shared quote cache.
  const hub = createSnapshotStreamHub({ read: live, intervalMs: 60_000, onError: () => app.log.warn({ code: 'STOCKS_LIVE_REFRESH_FAILED' }) });
  const clients = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => {
    hub.close();
    for (const client of clients) client.end();
    clients.clear();
  });
  app.get(`${ROOT}/NVDA/live`, async r => { query(r); return live(); });
  app.get(`${ROOT}/NVDA/live/stream`, async (request, reply) => {
    query(request);
    if (hub.subscriberCount() >= 64) return reply.code(503).send({ error: 'STREAM_CAPACITY' });
    reply.hijack();
    const raw = reply.raw;
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) raw.setHeader(name, value);
    raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    raw.setHeader('Cache-Control', 'no-store, no-transform');
    raw.setHeader('X-Content-Type-Options', 'nosniff');
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.flushHeaders();
    clients.add(raw);
    let active = true;
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (!active) return;
      active = false;
      clearInterval(heartbeat);
      unsubscribe();
      clients.delete(raw);
      if (!raw.writableEnded) raw.end();
    };
    raw.on('close', close);
    try { if (!raw.write(': connected\n\n')) { close(); return; } }
    catch { close(); return; }
    try {
      unsubscribe = hub.subscribe(snapshot => {
        if (!active || raw.writableEnded || !raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)) close();
      });
    } catch { close(); return; }
    // A cached snapshot can be delivered inside subscribe(), before it returns
    // the unsubscribe function. Backpressure may have closed this client then.
    if (!active) { unsubscribe(); return; }
    heartbeat = setInterval(() => {
      if (!active || raw.writableEnded || !raw.write(': keepalive\n\n')) close();
    }, 15_000);
    heartbeat.unref();
  });
  app.get(`${ROOT}/:symbol/profile`, async r => { query(r); return service.profile(symbol(r)); });
  app.get(`${ROOT}/:symbol/dividend`, async r => { query(r); return service.dividend(symbol(r)); });
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
