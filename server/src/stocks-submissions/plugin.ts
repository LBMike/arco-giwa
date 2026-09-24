import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ensure, immutable, PROFILE, StocksError, validateActor, type Actor } from '../stocks/contracts.js';
import type { StocksSubmissionsService } from './service.js';
export type StocksSubmissionsPluginOptions = { service: StocksSubmissionsService; resolveActor?: (request: FastifyRequest) => Promise<Actor | null> };
export async function stocksSubmissionsPlugin(app: FastifyInstance, options: StocksSubmissionsPluginOptions): Promise<void> {
  const actors = new WeakMap<FastifyRequest, Actor>();
  app.addHook('onRequest', async request => {
    let actor: Actor | null = null;
    try { actor = await options.resolveActor?.(request) ?? null; } catch { /* no credentials/errors escape */ }
    ensure(actor, 'UNAUTHORIZED', 401); validateActor(actor); actors.set(request, immutable(actor));
  });
  app.addHook('onSend', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StocksError) return reply.code(error.status).send({ error: error.code, ...PROFILE });
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status >= 400 && status < 500 ? 400 : 500).send({ error: status && status >= 400 && status < 500 ? 'INVALID_SUBMISSION_INPUT' : 'INTERNAL_ERROR', ...PROFILE });
  });
  const actor = (request: FastifyRequest) => { const value = actors.get(request); ensure(value, 'UNAUTHORIZED', 401); ensure(Object.keys(request.query as object).length === 0, 'INVALID_SUBMISSION_INPUT'); return value; };
  const envelope = (data: unknown) => ({ ...PROFILE, observedAt: new Date().toISOString(), data });
  app.get<{ Params: { side: string; orderId: string } }>('/api/v1/stocks/wallet-submissions/:side/:orderId', async r => envelope(await options.service.inspect(actor(r), r.params.side, r.params.orderId)));
  app.post('/api/v1/stocks/wallet-submissions/claims', { bodyLimit: 8192 }, async r => envelope(await options.service.claim(actor(r), r.body)));
  app.post('/api/v1/stocks/wallet-submissions/reconcile', { bodyLimit: 4096 }, async r => envelope(await options.service.reconcile(actor(r), r.body)));
  app.post('/api/v1/stocks/wallet-submissions/outcomes', { bodyLimit: 4096 }, async r => envelope(await options.service.record(actor(r), r.body)));
}
