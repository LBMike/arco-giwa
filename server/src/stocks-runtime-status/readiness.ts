import type { FastifyInstance } from 'fastify';
import type { StocksRuntimeSnapshot } from './contracts.js';
import { runtimeStatusEnvelope } from './snapshot.js';

const response = (ok: boolean) => ({ ok, service: 'arco-giwa-stocks', executionAuthorization: false });

/** Coarse process-local readiness for infrastructure probes; never transaction authorization. */
export async function stocksReadinessPlugin(app: FastifyInstance, options: {
  getSnapshot: () => StocksRuntimeSnapshot;
}): Promise<void> {
  app.addHook('onSend', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.addHook('onRequest', async (request, reply) => {
    if (request.raw.url?.includes('?') || Object.keys(request.query as object).length > 0 ||
        request.headers['transfer-encoding'] !== undefined ||
        (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
      return reply.code(400).send(response(false));
    }
  });
  app.setErrorHandler((_error, _request, reply) => reply.code(503).send(response(false)));
  app.get('/ready/stocks', async (request, reply) => {
    if (request.body !== undefined) return reply.code(400).send(response(false));
    let ok = false;
    try {
      // Re-read once on every probe: the runtime source reevaluates observer and control freshness.
      // Share the diagnostic validation, but never expose its detailed envelope on this public route.
      const { data } = runtimeStatusEnvelope(options.getSnapshot());
      ok = data.runtimeState === 'RUNNING' && data.autodispatch && data.observerStatus === 'CURRENT' &&
        data.operatorControl?.status !== 'UNAVAILABLE';
      // Configured/manual pauses are healthy maintenance states, not probe failures.
    } catch { /* Malformed snapshots and source exceptions fail closed without leaking details. */ }
    return reply.code(ok ? 200 : 503).send(response(ok));
  });
}
