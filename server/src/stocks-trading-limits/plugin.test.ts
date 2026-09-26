import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { PROFILE, StocksError, type Operator } from '../stocks/contracts.js';
import type { TradingLimitChange, TradingLimitCommand, TradingLimitEvent, TradingLimitsPort, TradingLimitsRead, TradingLimitView, TradingSide } from './contracts.js';
import { stocksTradingLimitsPlugin } from './plugin.js';

const path = '/api/v1/admin/stocks/limits';
const headers = { authorization: 'Bearer signed-operator-fixture' };
const readerHeaders = { authorization: 'Bearer signed-reader-fixture' };
const control: Operator = { operatorId: 'limits-operator', permissions: ['stocks:read', 'stocks:control'] };
const reader: Operator = { operatorId: 'limits-reader', permissions: ['stocks:read'] };
const time = '2026-09-26T03:00:00.000Z';
const digest = 'b'.repeat(64);
const window = { start: '2026-09-25T15:00:00.000Z', resetsAt: '2026-09-26T15:00:00.000Z', timeZone: 'Asia/Seoul' as const };
const valid: TradingLimitCommand = { enabled: true, dailyCashLimit: '50000000000', expectedVersion: 0, idempotencyKey: 'limit-key-0001', reason: 'Cap buys at 50,000' };
const view = (side: TradingSide, over: Partial<TradingLimitView> = {}): TradingLimitView => ({ deploymentDigest: digest, symbol: 'NVDA', side, enabled: true, dailyCashLimit: null, version: 0, updatedAt: null, operatorId: null, reason: null, usedToday: '0', ...over });
const initial = (): TradingLimitsRead => ({ items: [view('BUY'), view('SELL')], window });
const event = (input: TradingLimitCommand, side: TradingSide, actor: Operator): TradingLimitEvent => ({
  id: `limit-event-${input.expectedVersion + 1}`, deploymentDigest: digest, symbol: 'NVDA', side, version: input.expectedVersion + 1,
  previousEnabled: true, previousDailyCashLimit: null, enabled: input.enabled, dailyCashLimit: input.dailyCashLimit, operatorId: actor.operatorId, reason: input.reason, createdAt: time,
});
const change = (actor: Operator, side: TradingSide, input: TradingLimitCommand): TradingLimitChange => {
  const made = event(input, side, actor);
  return { state: { deploymentDigest: digest, symbol: 'NVDA', side, enabled: made.enabled, dailyCashLimit: made.dailyCashLimit, version: made.version, updatedAt: made.createdAt, operatorId: made.operatorId, reason: made.reason }, change: made, replayed: false };
};

function fixture(overrides: Partial<TradingLimitsPort> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service: TradingLimitsPort = {
    symbols: ['NVDA'],
    async read() { calls.push({ method: 'read', args: [] }); return overrides.read ? overrides.read() : initial(); },
    async history(...args) { calls.push({ method: 'history', args }); return overrides.history ? overrides.history(...args) : { items: [] }; },
    async change(...args) { calls.push({ method: 'change', args }); return overrides.change ? overrides.change(...args) : change(args[0], args[2], args[3]); },
  };
  const resolveOperator = async (request: FastifyRequest) => request.headers.authorization === headers.authorization ? control : request.headers.authorization === readerHeaders.authorization ? reader : null;
  const app = Fastify();
  app.register(stocksTradingLimitsPlugin, { service, resolveOperator });
  return { app, calls };
}
function data(response: { statusCode: number; headers: Record<string, unknown>; body: string; json(): any }, status = 200) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  const value = response.json();
  for (const [key, expected] of Object.entries(PROFILE)) assert.equal(value[key], expected);
  return value;
}
function failure(response: Parameters<typeof data>[0], status: number, code: string) {
  const value = data(response, status);
  assert.deepEqual(value, { ...PROFILE, observedAt: value.observedAt, data: null, error: code });
}

test('a reader gets one row per tradable side with the day it counts', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  const value = data(await app.inject({ url: path, headers: readerHeaders }));
  assert.deepEqual(value.data, initial());
  assert.deepEqual(calls, [{ method: 'read', args: [] }]);
});

test('a change needs stocks:control and passes only the server-resolved operator and the exact command', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  failure(await app.inject({ method: 'PUT', url: `${path}/NVDA/BUY`, headers: readerHeaders, payload: valid }), 403, 'OPERATOR_FORBIDDEN');
  failure(await app.inject({ method: 'PUT', url: `${path}/NVDA/BUY`, payload: valid }), 403, 'OPERATOR_FORBIDDEN');
  failure(await app.inject({ url: path }), 403, 'OPERATOR_FORBIDDEN');
  assert.equal(calls.length, 0);
  const value = data(await app.inject({ method: 'PUT', url: `${path}/NVDA/BUY`, headers: { ...headers, 'x-operator-id': 'forged', 'x-role': 'owner' }, payload: valid }));
  assert.deepEqual(value.data, change(control, 'BUY', valid));
  assert.deepEqual(calls, [{ method: 'change', args: [control, 'NVDA', 'BUY', valid] }]);
  assert.equal(Object.isFrozen(calls[0].args[0]), true);
  const off = { ...valid, enabled: false, dailyCashLimit: null, idempotencyKey: 'limit-key-0002' };
  assert.equal(data(await app.inject({ method: 'PUT', url: `${path}/NVDA/SELL`, headers, payload: off })).data.state.enabled, false);
});

test('malformed changes and queries are refused before the service', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  const bad: Array<[string, unknown]> = [
    [`${path}/TSLA/BUY`, valid], [`${path}/NVDA/HOLD`, valid], [`${path}/nvda/BUY`, valid],
    [`${path}/NVDA/BUY`, { ...valid, dailyCashLimit: '0' }], [`${path}/NVDA/BUY`, { ...valid, dailyCashLimit: '1.5' }],
    [`${path}/NVDA/BUY`, { ...valid, dailyCashLimit: 5 }], [`${path}/NVDA/BUY`, { ...valid, dailyCashLimit: '-1' }],
    [`${path}/NVDA/BUY`, { ...valid, dailyCashLimit: '1'.padEnd(32, '0') }],
    [`${path}/NVDA/BUY`, { ...valid, enabled: 'yes' }], [`${path}/NVDA/BUY`, { ...valid, expectedVersion: -1 }],
    [`${path}/NVDA/BUY`, { ...valid, expectedVersion: 1.5 }], [`${path}/NVDA/BUY`, { ...valid, idempotencyKey: 'short' }],
    [`${path}/NVDA/BUY`, { ...valid, reason: '' }], [`${path}/NVDA/BUY`, { ...valid, reason: ' padded' }],
    [`${path}/NVDA/BUY`, { ...valid, operatorId: 'forged' }], [`${path}/NVDA/BUY`, { enabled: true }], [`${path}/NVDA/BUY?x=1`, valid],
  ];
  for (const [url, payload] of bad) failure(await app.inject({ method: 'PUT', url, headers, payload: payload as object }), 400, 'INVALID_TRADING_LIMIT_INPUT');
  failure(await app.inject({ method: 'PUT', url: `${path}/NVDA/BUY`, headers: { ...headers, 'content-type': 'application/json' }, payload: '{bad json' }), 400, 'INVALID_TRADING_LIMIT_INPUT');
  failure(await app.inject({ url: `${path}?limit=1`, headers }), 400, 'INVALID_TRADING_LIMIT_INPUT');
  for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=abc', 'before=1']) failure(await app.inject({ url: `${path}/history?${query}`, headers }), 400, 'INVALID_TRADING_LIMIT_INPUT');
  assert.deepEqual(calls, []);
  data(await app.inject({ url: `${path}/history?limit=100`, headers }));
  data(await app.inject({ url: `${path}/history`, headers }));
  assert.deepEqual(calls, [{ method: 'history', args: [100] }, { method: 'history', args: [50] }]);
});

test('service conflicts keep their codes; anything else becomes 503 without detail', async t => {
  for (const [thrown, status, code] of [
    [new StocksError('LIMIT_VERSION_CONFLICT', 409), 409, 'LIMIT_VERSION_CONFLICT'],
    [new StocksError('LIMIT_IDEMPOTENCY_CONFLICT', 409), 409, 'LIMIT_IDEMPOTENCY_CONFLICT'],
    [new StocksError('OPERATOR_FORBIDDEN', 403), 403, 'OPERATOR_FORBIDDEN'],
    [new StocksError('INVALID_TRADING_LIMIT_INPUT', 400), 400, 'INVALID_TRADING_LIMIT_INPUT'],
    [new StocksError('LIMIT_VERSION_CONFLICT', 400), 503, 'TRADING_LIMITS_UNAVAILABLE'],
    [new Error('PRIVATE postgres://user:DO_NOT_LEAK@db'), 503, 'TRADING_LIMITS_UNAVAILABLE'],
  ] as const) {
    const { app } = fixture({ change: async () => { throw thrown; } }); t.after(() => app.close());
    const response = await app.inject({ method: 'PUT', url: `${path}/NVDA/BUY`, headers, payload: valid });
    failure(response, status, code);
    assert.doesNotMatch(response.body, /PRIVATE|DO_NOT_LEAK|postgres:/);
  }
});

test('a service answer that breaks the public contract is never passed through', async t => {
  const broken: Array<Partial<TradingLimitsPort>> = [
    { read: async () => ({ items: [view('BUY')], window }) },
    { read: async () => ({ items: [view('BUY'), view('BUY')], window }) },
    { read: async () => ({ items: [view('BUY', { usedToday: '-1' }), view('SELL')], window }) },
    { read: async () => ({ items: [view('BUY', { symbol: 'TSLA' }), view('SELL')], window }) },
    { read: async () => ({ items: [view('BUY', { version: 0, enabled: false }), view('SELL')], window }) },
    { read: async () => ({ items: [view('BUY', { version: 1 }), view('SELL')], window }) },
    { read: async () => ({ items: initial().items, window: { ...window, resetsAt: '2026-09-26T16:00:00.000Z' } }) },
    { read: async () => ({ items: initial().items, window: { ...window, timeZone: 'UTC' as never } }) },
    { change: async (actor, _symbol, side, input) => ({ ...change(actor, side, input), change: { ...change(actor, side, input).change, operatorId: 'someone-else' } }) },
    { change: async (actor, _symbol, side, input) => ({ ...change(actor, side, input), change: { ...change(actor, side, input).change, version: 5 } }) },
    { change: async (actor, _symbol, side, input) => change(actor, side === 'BUY' ? 'SELL' : 'BUY', input) },
    { change: async (actor, _symbol, side, input) => ({ ...change(actor, side, input), state: { ...change(actor, side, input).state, dailyCashLimit: null } }) },
    { history: async () => ({ items: [event(valid, 'BUY', control), { ...event(valid, 'SELL', control), createdAt: '2026-09-27T00:00:00.000Z' }] }) },
  ];
  for (const overrides of broken) {
    const { app } = fixture(overrides); t.after(() => app.close());
    const request = overrides.read ? { url: path, headers } : overrides.history ? { url: `${path}/history`, headers } : { method: 'PUT' as const, url: `${path}/NVDA/BUY`, headers, payload: valid };
    failure(await app.inject(request), 503, 'TRADING_LIMITS_UNAVAILABLE');
  }
});
