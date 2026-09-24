import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { freezeManifest, StocksError, type Manifest } from '../stocks/contracts.js';
import type { createStocksSignerCore } from './core.js';

type SignerCore = ReturnType<typeof createStocksSignerCore>;
export type SignerHttpOptions = {
  manifest: Manifest;
  core: SignerCore;
  /** A separately provisioned, random 256-bit token encoded as base64url or hex. */
  bearerToken: string;
  ready: () => Promise<boolean>;
};

const json = (error: string) => ({ error });
const requestCodes = new Set([
  'SIGNER_OPERATION_ID_INVALID', 'SIGNER_REQUEST_INVALID', 'SIGNER_DEPLOYMENT_MISMATCH',
  'SIGNER_OPERATION_MISMATCH', 'SIGNER_CALL_CAPABILITY_MISMATCH', 'SIGNER_CALL_SCOPE_MISMATCH',
]);

function bearerHeader(request: FastifyRequest): { count: number; value: string } {
  const raw = request.raw.rawHeaders;
  let count = 0;
  let value = '';
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (raw[index].toLowerCase() === 'authorization') {
      count++;
      value = raw[index + 1];
    }
  }
  return { count, value };
}

/** Inactive app factory. Its caller must separately prove custody and readiness. */
export function createStocksSignerHttpService(options: SignerHttpOptions): FastifyInstance {
  const manifest = freezeManifest(options.manifest);
  const token = options.bearerToken;
  if (typeof token !== 'string' || !(/^[A-Za-z0-9_-]{43}$/.test(token) && Buffer.from(token, 'base64url').length === 32
    && Buffer.from(token, 'base64url').toString('base64url') === token || /^[0-9a-f]{64}$/.test(token)))
    throw new Error('SIGNER_TOKEN_CONFIGURATION_INVALID');
  if (typeof options.ready !== 'function' || !options.core || typeof options.core.submit !== 'function'
    || typeof options.core.lookup !== 'function') throw new Error('SIGNER_SERVICE_CONFIGURATION_INVALID');
  const expected = createHash('sha256').update(token).digest();
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, exposeHeadRoutes: false, trustProxy: false });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const header = bearerHeader(request);
    const matched = /^Bearer ([A-Za-z0-9_-]{43}|[0-9a-f]{64})$/.exec(header.value);
    const candidate = matched?.[1] ?? '';
    const actual = createHash('sha256').update(candidate).digest();
    const equal = timingSafeEqual(expected, actual);
    if (header.count !== 1 || !matched || !equal) return reply.code(401).send(json('UNAUTHORIZED'));
    let ready = false;
    try { ready = await options.ready() === true; }
    catch { /* Readiness failures never reveal internal state. */ }
    if (!ready) return reply.code(503).send(json('SIGNER_NOT_READY'));
  });

  app.setErrorHandler((error, _request, reply) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send(json('SIGNER_BODY_TOO_LARGE'));
    if (error instanceof StocksError) {
      if (error.status === 409 && error.code === 'SIGNER_IMMUTABLE_OPERATION_CONFLICT')
        return reply.code(409).send(json(error.code));
      if (error.status === 400 && requestCodes.has(error.code))
        return reply.code(400).send(json(error.code));
      if (error.status === 503 && error.code === 'SIGNER_ORIGINAL_OUTCOME_UNKNOWN')
        return reply.code(503).send(json(error.code));
    }
    if (statusCode === 400) return reply.code(400).send(json('SIGNER_REQUEST_INVALID'));
    return reply.code(503).send(json('SIGNER_UNAVAILABLE'));
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(json('NOT_FOUND')));

  app.get('/v1/capabilities', async () => ({
    protocol: 'ARCO_STOCKS_SIGNER_V1', profile: 'DEMO_TESTNET', chainId: 91342,
    signerAddress: manifest.signerAddress, noncePolicy: 'DURABLE_SERIALIZED',
    operationPolicy: 'IMMUTABLE_IDEMPOTENT', replacementPolicy: 'DISABLED',
  }));
  app.get<{ Params: { operationId: string } }>('/v1/operations/:operationId', async (request, reply) => {
    const found = await options.core.lookup(request.params.operationId);
    if (found === null) return reply.code(404).send(json('SIGNER_OPERATION_UNKNOWN'));
    return found;
  });
  app.put<{ Params: { operationId: string } }>('/v1/operations/:operationId', async (request, reply) => {
    const result = await options.core.submit(request.params.operationId, request.body);
    if (result === null) return reply.code(503).send(json('SIGNER_ORIGINAL_OUTCOME_UNKNOWN'));
    return result;
  });
  return app;
}
