import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PROFILE, StocksError, type Operator } from '../stocks/contracts.js';
import type { TradingControlCommand, TradingControlPort } from './contracts.js';

export type StocksTradingControlPluginOptions = {
  service: TradingControlPort;
  resolveOperator?: (request: FastifyRequest) => Promise<Operator | null>;
};

const PATH = '/api/v1/admin/stocks/trading-control';
const INPUT = 'INVALID_TRADING_CONTROL_INPUT';
const UNAVAILABLE = 'TRADING_CONTROL_UNAVAILABLE';
const MAX_VERSION = 2_147_483_647;
const FLAGS = { executionAuthorization: false, inFlightMayContinue: true } as const;
const PUBLIC_ERRORS = new Map([
  [INPUT, 400], ['OPERATOR_FORBIDDEN', 403],
  ['CONTROL_VERSION_CONFLICT', 409], ['CONTROL_IDEMPOTENCY_CONFLICT', 409],
]);

function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new StocksError(INPUT, 400);
}
function requirePublic(condition: unknown): asserts condition {
  if (!condition) throw new StocksError(UNAVAILABLE, 503);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min: number, max = MAX_VERSION): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
function operatorId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function reason(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 500 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function publicState(raw: unknown) {
  requirePublic(record(raw));
  const { deploymentDigest, paused, version, updatedAt, operatorId: id, reason: note } = raw;
  requirePublic(digest(deploymentDigest) && typeof paused === 'boolean' && integer(version, 0));
  if (version === 0) requirePublic(paused === true && updatedAt === null && id === null && note === null);
  else requirePublic(iso(updatedAt) && operatorId(id) && reason(note));
  return { deploymentDigest, paused, version, updatedAt, operatorId: id, reason: note };
}
function publicEvent(raw: unknown) {
  requirePublic(record(raw));
  const { id, deploymentDigest, version, previousPaused, paused, operatorId: named, reason: note, createdAt } = raw;
  requirePublic(typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(id));
  requirePublic(digest(deploymentDigest) && integer(version, 1) && typeof previousPaused === 'boolean' && typeof paused === 'boolean');
  requirePublic(operatorId(named) && reason(note) && iso(createdAt));
  return { id, deploymentDigest, version, previousPaused, paused, operatorId: named, reason: note, createdAt };
}
function command(raw: unknown): TradingControlCommand {
  requireInput(record(raw));
  const keys = Object.keys(raw).sort();
  requireInput(keys.length === 4 && keys.join(',') === 'expectedVersion,idempotencyKey,paused,reason');
  const { paused, expectedVersion, idempotencyKey, reason: note } = raw;
  requireInput(typeof paused === 'boolean' && integer(expectedVersion, 0, MAX_VERSION - 1));
  requireInput(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(idempotencyKey) && reason(note));
  return { paused, expectedVersion, idempotencyKey, reason: note };
}
function historyQuery(raw: unknown) {
  requireInput(record(raw) && Object.keys(raw).every(key => key === 'limit' || key === 'beforeVersion'));
  const number = (value: unknown, max: number): number => {
    requireInput(typeof value === 'string' && /^[1-9]\d*$/.test(value));
    const parsed = Number(value);
    requireInput(integer(parsed, 1, max));
    return parsed;
  };
  return {
    limit: raw.limit === undefined ? 50 : number(raw.limit, 100),
    beforeVersion: raw.beforeVersion === undefined ? undefined : number(raw.beforeVersion, MAX_VERSION),
  };
}
function envelope(data: unknown) { return { ...PROFILE, observedAt: new Date().toISOString(), data }; }
function failure(error: string) { return { ...envelope(null), error }; }

/** Named, server-resolved authority only. No browser-supplied role grants access. */
export async function stocksTradingControlPlugin(app: FastifyInstance, options: StocksTradingControlPluginOptions): Promise<void> {
  const operators = new WeakMap<FastifyRequest, Operator>();
  const queries = new WeakMap<FastifyRequest, ReturnType<typeof historyQuery>>();
  app.addHook('onRequest', async request => {
    let named: Operator | null = null;
    try {
      const resolved = await options.resolveOperator?.(request);
      const required = request.method === 'POST' ? 'stocks:control' : 'stocks:read';
      if (resolved && operatorId(resolved.operatorId) && Array.isArray(resolved.permissions) && resolved.permissions.includes(required)) {
        named = { operatorId: resolved.operatorId, permissions: Object.freeze([...resolved.permissions]) };
      }
    } catch { /* Private authentication failures never escape. */ }
    if (!named) throw new StocksError('OPERATOR_FORBIDDEN', 403);
    operators.set(request, Object.freeze(named));
    if (request.method === 'GET') {
      // Reject even malformed JSON before parsing it, after authenticating the caller.
      requireInput(request.headers['transfer-encoding'] === undefined && (request.headers['content-length'] === undefined || request.headers['content-length'] === '0'));
      if (request.routeOptions.url === `${PATH}/history`) queries.set(request, historyQuery(request.query));
      else requireInput(!request.raw.url?.includes('?') && Object.keys(request.query as object).length === 0);
    } else requireInput(!request.raw.url?.includes('?') && Object.keys(request.query as object).length === 0);
  });
  app.addHook('onSend', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StocksError) {
      const status = PUBLIC_ERRORS.get(error.code);
      if (status === error.status) return reply.code(status).send(failure(error.code));
    } else {
      const status = (error as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(400).send(failure(INPUT));
    }
    return reply.code(503).send(failure(UNAVAILABLE));
  });
  // Errors originating in the service never inherit Fastify's parser-error mapping.
  const service = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) {
      if (error instanceof StocksError && PUBLIC_ERRORS.get(error.code) === error.status) throw error;
      throw new StocksError(UNAVAILABLE, 503);
    }
  };
  app.get(PATH, { exposeHeadRoute: false }, async request => {
    requireInput(request.body === undefined);
    const raw = await service(() => options.service.read());
    try { return envelope({ state: publicState(raw), ...FLAGS }); }
    catch { throw new StocksError(UNAVAILABLE, 503); }
  });
  app.get(`${PATH}/history`, { exposeHeadRoute: false }, async request => {
    requireInput(request.body === undefined);
    const query = queries.get(request)!;
    const raw = await service(() => options.service.history(query.limit, query.beforeVersion));
    try {
      requirePublic(record(raw));
      const { items: input, nextBeforeVersion } = raw;
      requirePublic(Array.isArray(input) && input.length <= query.limit);
      const items = input.map(publicEvent);
      requirePublic(items.every((item, index) => (query.beforeVersion === undefined || item.version < query.beforeVersion) && (index === 0 || (item.version < items[index - 1].version && item.deploymentDigest === items[0].deploymentDigest))));
      requirePublic(nextBeforeVersion === null || (items.length === query.limit && nextBeforeVersion === items[items.length - 1]?.version));
      return envelope({ items, nextBeforeVersion, ...FLAGS });
    } catch { throw new StocksError(UNAVAILABLE, 503); }
  });
  app.post(PATH, { bodyLimit: 4096 }, async request => {
    const input = command(request.body);
    const raw = await service(() => options.service.change(operators.get(request)!, input));
    try {
      requirePublic(record(raw));
      const { state: rawState, change: rawChange, replayed } = raw;
      const state = publicState(rawState), change = publicEvent(rawChange);
      requirePublic(typeof replayed === 'boolean' && state.deploymentDigest === change.deploymentDigest && state.version >= change.version);
      requirePublic(change.version === input.expectedVersion + 1 && change.paused === input.paused && change.reason === input.reason && change.operatorId === operators.get(request)!.operatorId);
      if (state.version === change.version) requirePublic(state.paused === change.paused && state.updatedAt === change.createdAt && state.operatorId === change.operatorId && state.reason === change.reason);
      return envelope({ state, change, replayed, ...FLAGS });
    } catch { throw new StocksError(UNAVAILABLE, 503); }
  });
}
