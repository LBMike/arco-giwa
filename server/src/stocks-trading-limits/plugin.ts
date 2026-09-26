import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PROFILE, StocksError, type Operator } from '../stocks/contracts.js';
import { validTradingControlText } from '../stocks-trading-control/validation.js';
import { TRADING_LIMIT_TIME_ZONE, type TradingLimitCommand, type TradingLimitsPort, type TradingSide } from './contracts.js';
import { isTradingSide, validDailyCashLimit } from './service.js';

export type StocksTradingLimitsPluginOptions = {
  service: TradingLimitsPort;
  resolveOperator?: (request: FastifyRequest) => Promise<Operator | null>;
};

const PATH = '/api/v1/admin/stocks/limits';
const INPUT = 'INVALID_TRADING_LIMIT_INPUT';
const UNAVAILABLE = 'TRADING_LIMITS_UNAVAILABLE';
const MAX_VERSION = 2_147_483_647;
const PUBLIC_ERRORS = new Map([
  [INPUT, 400], ['OPERATOR_FORBIDDEN', 403],
  ['LIMIT_VERSION_CONFLICT', 409], ['LIMIT_IDEMPOTENCY_CONFLICT', 409],
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
  return validTradingControlText(value, 128);
}
function reason(value: unknown): value is string {
  return validTradingControlText(value, 500);
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function unsigned(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,40})$/.test(value);
}

function publicState(raw: unknown, symbols: readonly string[]) {
  requirePublic(record(raw));
  const { deploymentDigest, symbol, side, enabled, dailyCashLimit, version, updatedAt, operatorId: id, reason: note } = raw;
  requirePublic(digest(deploymentDigest) && typeof symbol === 'string' && symbols.includes(symbol) && isTradingSide(side));
  requirePublic(typeof enabled === 'boolean' && validDailyCashLimit(dailyCashLimit) && integer(version, 0));
  if (version === 0) requirePublic(enabled === true && dailyCashLimit === null && updatedAt === null && id === null && note === null);
  else requirePublic(iso(updatedAt) && operatorId(id) && reason(note));
  return { deploymentDigest, symbol, side, enabled, dailyCashLimit, version, updatedAt, operatorId: id, reason: note };
}
function publicEvent(raw: unknown, symbols: readonly string[]) {
  requirePublic(record(raw));
  const { id, deploymentDigest, symbol, side, version, previousEnabled, previousDailyCashLimit, enabled, dailyCashLimit, operatorId: named, reason: note, createdAt } = raw;
  requirePublic(typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(id));
  requirePublic(digest(deploymentDigest) && typeof symbol === 'string' && symbols.includes(symbol) && isTradingSide(side) && integer(version, 1));
  requirePublic(typeof previousEnabled === 'boolean' && validDailyCashLimit(previousDailyCashLimit) && typeof enabled === 'boolean' && validDailyCashLimit(dailyCashLimit));
  requirePublic(operatorId(named) && reason(note) && iso(createdAt));
  return { id, deploymentDigest, symbol, side, version, previousEnabled, previousDailyCashLimit, enabled, dailyCashLimit, operatorId: named, reason: note, createdAt };
}
function command(raw: unknown): TradingLimitCommand {
  requireInput(record(raw));
  const keys = Object.keys(raw).sort();
  requireInput(keys.length === 5 && keys.join(',') === 'dailyCashLimit,enabled,expectedVersion,idempotencyKey,reason');
  const { enabled, dailyCashLimit, expectedVersion, idempotencyKey, reason: note } = raw;
  requireInput(typeof enabled === 'boolean' && validDailyCashLimit(dailyCashLimit) && integer(expectedVersion, 0, MAX_VERSION - 1));
  requireInput(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9:_-]{8,128}$/.test(idempotencyKey) && reason(note));
  return { enabled, dailyCashLimit, expectedVersion, idempotencyKey, reason: note };
}
function historyQuery(raw: unknown): number {
  requireInput(record(raw) && Object.keys(raw).every(key => key === 'limit'));
  if (raw.limit === undefined) return 50;
  requireInput(typeof raw.limit === 'string' && /^[1-9]\d{0,2}$/.test(raw.limit));
  const limit = Number(raw.limit);
  requireInput(limit <= 100);
  return limit;
}
function envelope(data: unknown) { return { ...PROFILE, observedAt: new Date().toISOString(), data }; }
function failure(error: string) { return { ...envelope(null), error }; }

/** Named, server-resolved authority only: reads need stocks:read, a change needs stocks:control. */
export async function stocksTradingLimitsPlugin(app: FastifyInstance, options: StocksTradingLimitsPluginOptions): Promise<void> {
  const symbols = options.service.symbols;
  const operators = new WeakMap<FastifyRequest, Operator>();
  const limits = new WeakMap<FastifyRequest, number>();
  app.addHook('onRequest', async request => {
    let named: Operator | null = null;
    try {
      const resolved = await options.resolveOperator?.(request);
      const required = request.method === 'PUT' ? 'stocks:control' : 'stocks:read';
      if (resolved && operatorId(resolved.operatorId) && Array.isArray(resolved.permissions) && resolved.permissions.includes(required)) {
        named = { operatorId: resolved.operatorId, permissions: Object.freeze([...resolved.permissions]) };
      }
    } catch { /* Private authentication failures never escape. */ }
    if (!named) throw new StocksError('OPERATOR_FORBIDDEN', 403);
    operators.set(request, Object.freeze(named));
    if (request.method === 'GET') {
      requireInput(request.headers['transfer-encoding'] === undefined && (request.headers['content-length'] === undefined || request.headers['content-length'] === '0'));
      if (request.routeOptions.url === `${PATH}/history`) limits.set(request, historyQuery(request.query));
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
    try {
      requirePublic(record(raw) && Array.isArray(raw.items) && record(raw.window));
      const items = raw.items.map(item => {
        requirePublic(record(item) && unsigned(item.usedToday));
        return { ...publicState(item, symbols), usedToday: item.usedToday };
      });
      // Exactly one row per tradable (symbol, side), in the service's order.
      requirePublic(items.length === symbols.length * 2 && new Set(items.map(item => `${item.symbol}:${item.side}`)).size === items.length);
      const { start, resetsAt, timeZone } = raw.window;
      requirePublic(iso(start) && iso(resetsAt) && Date.parse(resetsAt) - Date.parse(start) === 86_400_000 && timeZone === TRADING_LIMIT_TIME_ZONE);
      return envelope({ items, window: { start, resetsAt, timeZone } });
    } catch { throw new StocksError(UNAVAILABLE, 503); }
  });

  app.get(`${PATH}/history`, { exposeHeadRoute: false }, async request => {
    requireInput(request.body === undefined);
    const limit = limits.get(request)!;
    const raw = await service(() => options.service.history(limit));
    try {
      requirePublic(record(raw) && Array.isArray(raw.items) && raw.items.length <= limit);
      const items = raw.items.map(item => publicEvent(item, symbols));
      requirePublic(items.every((item, index) => index === 0 || (item.createdAt <= items[index - 1].createdAt && item.deploymentDigest === items[0].deploymentDigest)));
      return envelope({ items });
    } catch { throw new StocksError(UNAVAILABLE, 503); }
  });

  app.put<{ Params: { symbol: string; side: string } }>(`${PATH}/:symbol/:side`, { bodyLimit: 4096 }, async request => {
    const { symbol, side } = request.params;
    requireInput(typeof symbol === 'string' && symbols.includes(symbol) && isTradingSide(side));
    const input = command(request.body);
    const operator = operators.get(request)!;
    const raw = await service(() => options.service.change(operator, symbol, side as TradingSide, input));
    try {
      requirePublic(record(raw));
      const { state: rawState, change: rawChange, replayed } = raw;
      const state = publicState(rawState, symbols), change = publicEvent(rawChange, symbols);
      requirePublic(typeof replayed === 'boolean' && state.deploymentDigest === change.deploymentDigest && state.symbol === symbol && state.side === side && change.symbol === symbol && change.side === side && state.version >= change.version);
      requirePublic(change.version === input.expectedVersion + 1 && change.enabled === input.enabled && change.dailyCashLimit === input.dailyCashLimit && change.reason === input.reason && change.operatorId === operator.operatorId);
      if (state.version === change.version) requirePublic(state.enabled === change.enabled && state.dailyCashLimit === change.dailyCashLimit && state.updatedAt === change.createdAt && state.operatorId === change.operatorId && state.reason === change.reason);
      return envelope({ state, change, replayed });
    } catch { throw new StocksError(UNAVAILABLE, 503); }
  });
}
