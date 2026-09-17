import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PROFILE, StocksError, type Operator } from '../stocks/contracts.js';
import type { SubmissionDiagnosticsReader } from './contracts.js';
import { publicSnapshot } from './public.js';

export type StocksSubmissionDiagnosticsPluginOptions = {
  service: SubmissionDiagnosticsReader;
  resolveOperator?: (request: FastifyRequest) => Promise<Operator | null>;
};
const INPUT_ERROR = 'INVALID_SUBMISSION_DIAGNOSTICS_INPUT';
const UNAVAILABLE = 'SUBMISSION_DIAGNOSTICS_UNAVAILABLE';
const failure = (error: string) => ({ error, ...PROFILE });

/** Read-only, named operator diagnostic. The resolver is the existing signed-session authority. */
export async function stocksSubmissionDiagnosticsPlugin(app: FastifyInstance, options: StocksSubmissionDiagnosticsPluginOptions): Promise<void> {
  app.addHook('onRequest', async request => {
    let authorized = false;
    try {
      const operator = await options.resolveOperator?.(request);
      authorized = !!operator && typeof operator.operatorId === 'string' && operator.operatorId.trim().length > 0 && operator.operatorId.length <= 128 && Array.isArray(operator.permissions) && operator.permissions.includes('stocks:read');
    } catch { /* Credentials, resolver errors and private configuration never escape. */ }
    if (!authorized) throw new StocksError('OPERATOR_FORBIDDEN', 403);
    // Reject a payload before JSON parsing, including malformed JSON and streamed bodies.
    if (request.raw.url?.includes('?') || Object.keys(request.query as object).length > 0 || request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
      throw new StocksError(INPUT_ERROR, 400);
    }
  });
  app.addHook('onSend', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StocksError && error.code === 'OPERATOR_FORBIDDEN') return reply.code(403).send(failure('OPERATOR_FORBIDDEN'));
    if (error instanceof StocksError && error.code === INPUT_ERROR) return reply.code(400).send(failure(INPUT_ERROR));
    const status = (error as { statusCode?: unknown }).statusCode;
    if (!(error instanceof StocksError) && typeof status === 'number' && status >= 400 && status < 500) return reply.code(400).send(failure(INPUT_ERROR));
    return reply.code(503).send(failure(UNAVAILABLE));
  });
  app.get<{ Params: { side: string; orderId: string } }>('/api/v1/admin/stocks/wallet-submissions/:side/:orderId', { exposeHeadRoute: false }, async (request, reply) => {
    const { side, orderId } = request.params;
    if ((side !== 'BUY' && side !== 'SELL') || typeof orderId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(orderId) || request.body !== undefined) throw new StocksError(INPUT_ERROR, 400);
    let raw: unknown;
    try {
      raw = await options.service.inspect(side, orderId);
    } catch (error) {
      // Only the service's explicit missing-order result is public. Never trust arbitrary statusCode.
      if (error instanceof StocksError && error.code === 'ORDER_NOT_FOUND' && error.status === 404) return reply.code(404).send(failure('ORDER_NOT_FOUND'));
      return reply.code(503).send(failure(UNAVAILABLE));
    }
    try {
      const snapshot = publicSnapshot(raw);
      if (snapshot.data.order.side !== side || snapshot.data.order.id !== orderId) throw new Error('scope mismatch');
      return { ...PROFILE, observedAt: snapshot.observedAt, data: snapshot.data };
    } catch {
      return reply.code(503).send(failure(UNAVAILABLE));
    }
  });
}
