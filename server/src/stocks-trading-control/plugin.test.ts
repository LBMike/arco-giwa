import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { PROFILE, StocksError, type Operator } from '../stocks/contracts.js';
import type { TradingControlChange, TradingControlCommand, TradingControlEvent, TradingControlPort, TradingControlState } from './contracts.js';
import { stocksTradingControlPlugin } from './plugin.js';

const path = '/api/v1/admin/stocks/trading-control';
const headers = { authorization: 'Bearer signed-operator-fixture' };
const named: Operator = { operatorId: 'named-operator', permissions: ['stocks:read', 'stocks:control'] };
const flags = { executionAuthorization: false, inFlightMayContinue: true };
const time = '2026-09-19T00:00:00.000Z';
const digest = 'a'.repeat(64);
const valid: TradingControlCommand = { paused: false, expectedVersion: 0, idempotencyKey: 'control-key-1', reason: 'Reconciliation checked' };
const initial = (): TradingControlState => ({ deploymentDigest: digest, paused: true, version: 0, updatedAt: null, operatorId: null, reason: null });
const event = (version = 1): TradingControlEvent => ({ id: `control-event-${version}`, deploymentDigest: digest, version, previousPaused: true, paused: false, operatorId: named.operatorId, reason: valid.reason, createdAt: time });
const change = (input = valid, actor = named): TradingControlChange => {
  const value = { ...event(input.expectedVersion + 1), paused: input.paused, reason: input.reason, operatorId: actor.operatorId };
  return { state: { deploymentDigest: digest, paused: value.paused, version: value.version, updatedAt: value.createdAt, operatorId: value.operatorId, reason: value.reason }, change: value, replayed: false };
};
function fixture(overrides: Partial<TradingControlPort> = {}, resolveOperator: (request: FastifyRequest) => Promise<Operator | null> = async request => request.headers.authorization === headers.authorization ? named : null) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service: TradingControlPort = {
    async read() { calls.push({ method: 'read', args: [] }); return overrides.read ? overrides.read() : initial(); },
    async history(...args) { calls.push({ method: 'history', args }); return overrides.history ? overrides.history(...args) : { items: [], nextBeforeVersion: null }; },
    async change(...args) { calls.push({ method: 'change', args }); return overrides.change ? overrides.change(...args) : change(args[1], args[0]); },
  };
  const app = Fastify();
  app.register(stocksTradingControlPlugin, { service, resolveOperator });
  return { app, calls };
}
function responseData(response: { statusCode: number; headers: Record<string, unknown>; body: string; json(): any }, status = 200) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  const value = response.json();
  assert.equal(new Date(value.observedAt).toISOString(), value.observedAt);
  for (const [key, expected] of Object.entries(PROFILE)) assert.equal(value[key], expected);
  return value;
}
function error(response: Parameters<typeof responseData>[0], status: number, code: string) {
  const value = responseData(response, status);
  assert.deepEqual(value, { ...PROFILE, observedAt: value.observedAt, data: null, error: code });
  assert.doesNotMatch(response.body, /PRIVATE|DO_NOT_LEAK|password|postgres:/);
}

test('initial state is safely paused and read success has the exact public envelope', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  const response = await app.inject({ url: path, headers });
  const value = responseData(response);
  assert.deepEqual(value, { ...PROFILE, observedAt: value.observedAt, data: { state: initial(), ...flags } });
  assert.deepEqual(calls, [{ method: 'read', args: [] }]);
});

test('POST uses only server identity and copies a valid command; response is never execution authorization', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: path, headers: { ...headers, 'x-role': 'owner', 'x-operator-id': 'forged' }, payload: valid });
  const value = responseData(response);
  assert.deepEqual(value.data, { ...change(), ...flags });
  assert.deepEqual(calls, [{ method: 'change', args: [named, valid] }]);
  assert.equal(Object.isFrozen(calls[0].args[0]), true);
  assert.equal(Object.isFrozen((calls[0].args[0] as Operator).permissions), true);
});

test('history defaults and valid bounds are parsed once with exact service arguments', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  for (const [suffix, args] of [
    ['', [50, undefined]], ['?limit=1', [1, undefined]], ['?limit=100&beforeVersion=2147483647', [100, 2147483647]], ['?beforeVersion=1', [50, 1]],
  ] as const) {
    const response = await app.inject({ url: `${path}/history${suffix}`, headers });
    assert.deepEqual(responseData(response).data, { items: [], nextBeforeVersion: null, ...flags });
    assert.deepEqual(calls[calls.length - 1], { method: 'history', args });
  }
});

test('authentication happens before query, body parsing, size errors, and every service method', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  for (const request of [
    { method: 'GET' as const, url: `${path}?unknown=1` },
    { method: 'GET' as const, url: `${path}/history?limit=bad` },
    { method: 'GET' as const, url: path, payload: '{broken', headers: { 'content-type': 'application/json' } },
    { method: 'POST' as const, url: path, payload: '{broken', headers: { 'content-type': 'application/json' } },
    { method: 'POST' as const, url: path, payload: 'x'.repeat(5000), headers: { 'content-type': 'application/json' } },
    { method: 'POST' as const, url: path, payload: { ...valid, role: 'admin' }, headers: { 'x-operator-token': 'legacy', 'x-role': 'admin' } },
    { method: 'GET' as const, url: path, headers: { authorization: 'Bearer browser-role', 'x-operator-token': 'legacy' } },
  ]) error(await app.inject(request), 403, 'OPERATOR_FORBIDDEN');
  assert.deepEqual(calls, []);
});

for (const [label, operator] of [
  ['null', null], ['unnamed', { permissions: ['stocks:read', 'stocks:control'] }],
  ['empty', { operatorId: '', permissions: ['stocks:read', 'stocks:control'] }],
  ['blank', { operatorId: '  ', permissions: ['stocks:read', 'stocks:control'] }],
  ['padded', { operatorId: ' operator ', permissions: ['stocks:read', 'stocks:control'] }],
  ['control character', { operatorId: 'operator\nname', permissions: ['stocks:read', 'stocks:control'] }],
  ['too long', { operatorId: 'x'.repeat(129), permissions: ['stocks:read', 'stocks:control'] }],
  ['no permissions', { operatorId: 'named', permissions: [] }],
  ['string permissions', { operatorId: 'named', permissions: 'stocks:read stocks:control' }],
] as const) test(`invalid resolver identity ${label} fails before service`, async t => {
  const { app, calls } = fixture({}, async () => operator as Operator | null); t.after(() => app.close());
  for (const [method, url] of [['GET', path], ['GET', `${path}/history`], ['POST', path]] as const) error(await app.inject({ method, url, headers, ...(method === 'POST' ? { payload: valid } : {}) }), 403, 'OPERATOR_FORBIDDEN');
  assert.deepEqual(calls, []);
});

test('read and control permissions do not imply each other', async t => {
  const reader = fixture({}, async () => ({ operatorId: 'reader', permissions: ['stocks:read'] })); t.after(() => reader.app.close());
  error(await reader.app.inject({ method: 'POST', url: path, headers, payload: valid }), 403, 'OPERATOR_FORBIDDEN');
  assert.deepEqual(reader.calls, []);
  assert.equal((await reader.app.inject({ url: path, headers })).statusCode, 200);
  const controller = fixture({}, async () => ({ operatorId: 'controller', permissions: ['stocks:control'] })); t.after(() => controller.app.close());
  for (const url of [path, `${path}/history`]) error(await controller.app.inject({ url, headers }), 403, 'OPERATOR_FORBIDDEN');
  assert.deepEqual(controller.calls, []);
  assert.equal((await controller.app.inject({ method: 'POST', url: path, headers, payload: valid })).statusCode, 200);
});

test('absent resolver and thrown/private resolver failures fail closed', async t => {
  const never: TradingControlPort = { read: async () => { throw Error('PRIVATE'); }, history: async () => { throw Error('PRIVATE'); }, change: async () => { throw Error('PRIVATE'); } };
  const absent = Fastify(); absent.register(stocksTradingControlPlugin, { service: never }); t.after(() => absent.close());
  error(await absent.inject({ url: path, headers }), 403, 'OPERATOR_FORBIDDEN');
  for (const resolver of [async () => { throw new StocksError('PRIVATE_CREDENTIALS', 500); }, async () => Object.defineProperty({}, 'operatorId', { get() { throw Error('PRIVATE_GETTER'); } }) as Operator]) {
    const { app, calls } = fixture({}, resolver); t.after(() => app.close());
    error(await app.inject({ method: 'POST', url: path, headers, payload: valid }), 403, 'OPERATOR_FORBIDDEN');
    assert.deepEqual(calls, []);
  }
});

test('GET rejects payloads and state rejects all query keys without service access', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  for (const url of [path, `${path}/history`]) {
    for (const request of [
      { payload: '{broken', headers: { ...headers, 'content-type': 'application/json' } },
      { payload: { role: 'admin' }, headers },
      { payload: 'x', headers: { ...headers, 'transfer-encoding': 'chunked' } },
    ]) error(await app.inject({ method: 'GET', url, ...request }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  }
  for (const url of [`${path}?limit=1`, `${path}?__proto__[role]=admin`, `${path}?operatorId=forged`]) error(await app.inject({ url, headers }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  assert.deepEqual(calls, []);
});

test('history query enforces canonical integers, exact keys and duplicate rejection', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  for (const suffix of [
    'limit=0', 'limit=101', 'limit=-1', 'limit=1.0', 'limit=1e2', 'limit=01', 'limit=', 'limit=%201', 'limit=1&limit=2',
    'beforeVersion=0', 'beforeVersion=2147483648', 'beforeVersion=-1', 'beforeVersion=1.5', 'beforeVersion=01', 'beforeVersion=', 'beforeVersion=1&beforeVersion=2',
    'limit=999999999999999999999999', 'role=admin', 'limit[x]=1', '__proto__[x]=1', 'constructor=admin', 'toString=admin',
  ]) error(await app.inject({ url: `${path}/history?${suffix}`, headers }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  assert.deepEqual(calls, []);
});

test('POST exact input rejects malformed, extra, noncanonical and out-of-range values', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  const invalid: unknown[] = [null, [], true, 1, 'text', {}, { ...valid, operatorId: 'forged' }, { ...valid, role: 'admin' }, { ...valid, deploymentDigest: digest },
    { ...valid, paused: 'false' }, { ...valid, paused: 0 }, { ...valid, expectedVersion: -1 }, { ...valid, expectedVersion: 2147483647 }, { ...valid, expectedVersion: 0.5 }, { ...valid, expectedVersion: '0' },
    ...['short12', 'x'.repeat(129), 'bad key!', '키'.repeat(8), 'key\n12345'].map(idempotencyKey => ({ ...valid, idempotencyKey })),
    ...['', ' ', ' padded', 'padded ', 'x'.repeat(501), 'line\nbreak', 'tab\there', 'null\0byte', 'delete\u007f', 'control\u0085'].map(reason => ({ ...valid, reason })),
  ];
  for (const input of invalid) error(await app.inject({ method: 'POST', url: path, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(input) }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  for (const payload of ['{broken', '{"paused":false}', 'x'.repeat(4097)]) error(await app.inject({ method: 'POST', url: path, headers: { ...headers, 'content-type': 'application/json' }, payload }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  error(await app.inject({ method: 'POST', url: path, headers }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  error(await app.inject({ method: 'POST', url: `${path}?role=admin`, headers, payload: valid }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  assert.deepEqual(calls, []);
});

test('POST accepts exact input boundaries and UTF-8 reason within the body limit', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  for (const input of [
    { ...valid, expectedVersion: 0, paused: true, idempotencyKey: 'a:b_c-01', reason: 'x' },
    { ...valid, expectedVersion: 2147483646, idempotencyKey: 'x'.repeat(128), reason: '점'.repeat(500) },
  ]) {
    const response = await app.inject({ method: 'POST', url: path, headers, payload: input });
    assert.deepEqual(responseData(response).data, { ...change(input), ...flags });
    assert.deepEqual(calls[calls.length - 1]?.args[1], input);
  }
});

test('state and POST reject even an empty raw query delimiter', async t => {
  const app = Fastify(); let calls = 0;
  app.addHook('onRequest', async request => { request.raw.url += '?'; });
  app.register(stocksTradingControlPlugin, { service: { read: async () => { calls++; return initial(); }, history: async () => { calls++; return { items: [], nextBeforeVersion: null }; }, change: async () => { calls++; return change(); } }, resolveOperator: async () => named });
  t.after(() => app.close());
  error(await app.inject({ url: path, headers }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  error(await app.inject({ method: 'POST', url: path, headers, payload: valid }), 400, 'INVALID_TRADING_CONTROL_INPUT');
  assert.equal(calls, 0);
});

test('public fields are copied without enumerating raw metadata or private getters', async t => {
  const secret = <T extends object>(value: T): T => Object.defineProperties(value, {
    password: { enumerable: true, get() { throw new Error('PRIVATE_GETTER_MUST_NOT_RUN'); } },
    connection: { enumerable: true, value: 'postgres://PRIVATE' },
  });
  const rawChange = change(); secret(rawChange); secret(rawChange.state); secret(rawChange.change);
  const rawHistory = secret({ items: [secret(event(2)), secret(event(1))], nextBeforeVersion: 1 });
  const { app } = fixture({ read: async () => secret(initial()), change: async () => rawChange, history: async () => rawHistory }); t.after(() => app.close());
  for (const [url, expected] of [[path, { state: initial(), ...flags }], [`${path}/history?limit=2`, { items: [event(2), event(1)], nextBeforeVersion: 1, ...flags }]] as const) {
    const response = await app.inject({ url, headers }); assert.deepEqual(responseData(response).data, expected); assert.doesNotMatch(response.body, /PRIVATE|password|connection/);
  }
  const response = await app.inject({ method: 'POST', url: path, headers, payload: valid });
  assert.deepEqual(responseData(response).data, { ...change(), ...flags }); assert.doesNotMatch(response.body, /PRIVATE|password|connection/);
});

test('only recognized StocksError code and status pairs escape the service', async t => {
  for (const [failure, status, code] of [
    [new StocksError('INVALID_TRADING_CONTROL_INPUT', 400), 400, 'INVALID_TRADING_CONTROL_INPUT'],
    [new StocksError('OPERATOR_FORBIDDEN', 403), 403, 'OPERATOR_FORBIDDEN'],
    [new StocksError('CONTROL_VERSION_CONFLICT', 409), 409, 'CONTROL_VERSION_CONFLICT'],
    [new StocksError('CONTROL_IDEMPOTENCY_CONFLICT', 409), 409, 'CONTROL_IDEMPOTENCY_CONFLICT'],
    [new StocksError('CONTROL_VERSION_CONFLICT', 400), 503, 'TRADING_CONTROL_UNAVAILABLE'],
    [new StocksError('PRIVATE_SQL', 503), 503, 'TRADING_CONTROL_UNAVAILABLE'],
    [Object.assign(new Error('PRIVATE'), { statusCode: 400 }), 503, 'TRADING_CONTROL_UNAVAILABLE'],
    [{ code: 'CONTROL_VERSION_CONFLICT', status: 409 }, 503, 'TRADING_CONTROL_UNAVAILABLE'],
    [new Error('postgres://PRIVATE'), 503, 'TRADING_CONTROL_UNAVAILABLE'],
  ] as const) {
    const fail = async (): Promise<never> => { throw failure; };
    const { app, calls } = fixture({ read: fail, change: fail, history: fail }); t.after(() => app.close());
    for (const [method, url] of [['GET', path], ['GET', `${path}/history`], ['POST', path]] as const) error(await app.inject({ method, url, headers, ...(method === 'POST' ? { payload: valid } : {}) }), status, code);
    assert.equal(calls.length, 3);
  }
});

test('invalid state output fails503 and never returns raw data', async t => {
  for (const raw of [null, [], { ...initial(), paused: false }, { ...initial(), version: -1 }, { ...initial(), version: 2147483648 }, { ...initial(), deploymentDigest: 'PRIVATE' }, { ...initial(), updatedAt: time }, { ...change().state, updatedAt: '2026-02-30T00:00:00.000Z' }, { ...change().state, operatorId: '' }, { ...change().state, operatorId: ' padded ' }, { ...change().state, operatorId: 'operator\u0085name' }, { ...change().state, reason: ' padded ' }]) {
    const { app } = fixture({ read: async () => raw as TradingControlState }); t.after(() => app.close());
    error(await app.inject({ url: path, headers }), 503, 'TRADING_CONTROL_UNAVAILABLE');
  }
});

test('invalid history pages fail503 including scope, order, cursor and requested bounds', async t => {
  for (const raw of [null, { items: null, nextBeforeVersion: null }, { items: [event(1), event(2)], nextBeforeVersion: 2 }, { items: [event(1), event(1)], nextBeforeVersion: 1 },
    { items: [event(2), { ...event(1), deploymentDigest: 'b'.repeat(64) }], nextBeforeVersion: 1 },
    { items: [event(2), event(1)], nextBeforeVersion: 2 }, { items: [event(1)], nextBeforeVersion: 1 }, { items: [], nextBeforeVersion: 1 },
    { items: [event(3), event(2), event(1)], nextBeforeVersion: null }, { items: [{ ...event(1), id: '' }], nextBeforeVersion: null },
    { items: [{ ...event(1), operatorId: ' padded ' }], nextBeforeVersion: null }, { items: [{ ...event(1), operatorId: 'operator\nname' }], nextBeforeVersion: null },
  ]) {
    const { app } = fixture({ history: async () => raw as any }); t.after(() => app.close());
    error(await app.inject({ url: `${path}/history?limit=2`, headers }), 503, 'TRADING_CONTROL_UNAVAILABLE');
  }
  const { app } = fixture({ history: async () => ({ items: [event(2)], nextBeforeVersion: null }) }); t.after(() => app.close());
  error(await app.inject({ url: `${path}/history?beforeVersion=2`, headers }), 503, 'TRADING_CONTROL_UNAVAILABLE');
});

test('POST rejects incoherent service output, substituted command and operator', async t => {
  const good = change();
  for (const raw of [null, { ...good, replayed: 'false' }, { ...good, state: initial() },
    { ...good, change: { ...good.change, deploymentDigest: 'b'.repeat(64) } },
    { ...good, change: { ...good.change, paused: true } }, { ...good, change: { ...good.change, version: 2 } },
    { ...good, change: { ...good.change, operatorId: 'other' } }, { ...good, change: { ...good.change, reason: 'other' } },
    { ...good, state: { ...good.state, paused: true } }, { ...good, state: { ...good.state, reason: 'other' } },
    { ...good, state: { ...good.state, operatorId: 'other' } }, { ...good, state: { ...good.state, updatedAt: '2026-09-19T00:00:01.000Z' } },
  ]) {
    const { app } = fixture({ change: async () => raw as TradingControlChange }); t.after(() => app.close());
    error(await app.inject({ method: 'POST', url: path, headers, payload: valid }), 503, 'TRADING_CONTROL_UNAVAILABLE');
  }
});

test('replay and concurrent later state remain distinguishable from the recorded change', async t => {
  for (const replayed of [false, true]) {
    const raw = { ...change(), replayed, state: { ...change().state, version: 2, paused: true, operatorId: 'second-operator', reason: 'Second change', updatedAt: '2026-09-19T00:00:01.000Z' } };
    const { app } = fixture({ change: async () => raw }); t.after(() => app.close());
    const response = await app.inject({ method: 'POST', url: path, headers, payload: valid });
    assert.deepEqual(responseData(response).data, { ...raw, ...flags });
  }
});

test('public getters that fail are sanitized503 and unrelated methods never invoke the service', async t => {
  const raw = Object.defineProperty(initial(), 'paused', { get() { throw Error('PRIVATE_GETTER'); } });
  const { app, calls } = fixture({ read: async () => raw }); t.after(() => app.close());
  error(await app.inject({ url: path, headers }), 503, 'TRADING_CONTROL_UNAVAILABLE');
  for (const method of ['HEAD', 'PUT', 'PATCH', 'DELETE'] as const) assert.equal((await app.inject({ method, url: path, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `${path}/history`, headers, payload: valid })).statusCode, 404);
  assert.deepEqual(calls, [{ method: 'read', args: [] }]);
});
