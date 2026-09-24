import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { StocksObservationHealth } from '../stocks-runtime/health.js';
import { runtimeSnapshot } from '../stocks-runtime/status.js';
import { OBSERVER_STATES, type StocksRuntimeSnapshot } from './contracts.js';

const url = '/ready/stocks';
const body = (ok: boolean) => ({ ok, service: 'arco-giwa-stocks', executionAuthorization: false });
const env: AppEnv = {
  corsAllowedOrigins: ['https://stocks.local.test'], authNonceTtlSeconds: 60,
  authJwtSecret: 'TEST_ONLY_READINESS_SECRET', adminOperatorToken: 'TEST_ONLY_OPERATOR', registryPath: '/NO_REGISTRY',
};
function fixture(enabled = true) {
  let wall = Date.now(), mono = 0, calls = 0, authCalls = 0, legacyCalls = 0;
  const health = new StocksObservationHealth(() => wall, () => mono);
  const input = { deploymentId: 'private-deployment', deploymentDigest: 'a'.repeat(64),
    autodispatch: true, configuredPause: false, stopped: false, tickInFlight: false,
    operatorControl: undefined as StocksRuntimeSnapshot['operatorControl'] };
  let source: () => StocksRuntimeSnapshot = () => runtimeSnapshot({ ...input, health: health.snapshot() });
  const base = { arco: {}, registry: {}, portfolio: {}, readiness: { check: async () => {
    legacyCalls++; return { ok: true, checks: { legacy: true } };
  } } } as unknown as ArcoAppServices;
  const app = buildApp(env, { ...base, stocksRuntimeStatus: enabled ? {
    getSnapshot: () => { calls++; return source(); },
    resolveOperator: async () => { authCalls++; return null; },
  } : undefined });
  return { app, health, input, calls: () => calls, authCalls: () => authCalls, legacyCalls: () => legacyCalls,
    advance: (ms: number) => { wall += ms; mono += ms; },
    source: (get: () => StocksRuntimeSnapshot) => { source = get; } };
}

test('Stocks readiness is absent when disabled and preserves existing health/readiness', async t => {
  const f = fixture(false); t.after(() => f.app.close());
  assert.equal((await f.app.inject(url)).statusCode, 404);
  assert.deepEqual((await f.app.inject('/health')).json(), { ok: true, service: 'arco-giwa-api' });
  assert.deepEqual((await f.app.inject('/ready')).json(), { ok: true, checks: { legacy: true } });
  assert.equal(f.legacyCalls(), 1); assert.equal(f.calls(), 0);
});

test('probe reads one synchronous snapshot, exposes only coarse readiness, and leaves diagnostics protected', async t => {
  const f = fixture(); t.after(() => f.app.close()); f.health.record('CURRENT');
  const raw = runtimeSnapshot({ ...f.input, health: f.health.snapshot() });
  Object.defineProperty(raw, 'privateGetter', { get() { throw new Error('PRIVATE_TOKEN'); } });
  f.source(() => raw);
  const result = await f.app.inject(url);
  assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), body(true));
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(f.calls(), 1); assert.equal(f.authCalls(), 0); assert.equal(f.legacyCalls(), 0);
  const denied = await f.app.inject('/api/v1/admin/stocks/runtime');
  assert.equal(denied.statusCode, 403); assert.equal(f.authCalls(), 1); assert.equal(f.calls(), 1);
  const head = await f.app.inject({ method: 'HEAD', url });
  assert.equal(head.statusCode, 200); assert.equal(head.body, '');
  assert.equal(head.headers['cache-control'], 'no-store'); assert.equal(f.calls(), 2);
});

test('startup and every non-current observer state fail readiness while liveness remains healthy', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const state of OBSERVER_STATES.filter(state => state !== 'CURRENT')) {
    f.health.record(state); f.input.stopped = state === 'STOPPED';
    const result = await f.app.inject(url);
    assert.equal(result.statusCode, 503, state); assert.deepEqual(result.json(), body(false));
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal((await f.app.inject('/health')).statusCode, 200);
  }
});

test('readiness expires without a worker tick, recovers on fresh observation, and fails on clock reversal', async t => {
  const f = fixture(); t.after(() => f.app.close()); f.health.record('CURRENT');
  assert.equal((await f.app.inject(url)).statusCode, 200);
  f.advance(60000); assert.equal((await f.app.inject(url)).statusCode, 200);
  f.advance(1); assert.equal((await f.app.inject(url)).statusCode, 503);
  f.health.record('CURRENT'); assert.equal((await f.app.inject(url)).statusCode, 200);
  f.advance(-1); assert.equal((await f.app.inject(url)).statusCode, 503);
  assert.equal(f.calls(), 5);
});

test('intentional pauses remain ready, but unavailable control and disabled dispatch fail', async t => {
  const f = fixture(); t.after(() => f.app.close()); f.health.record('CURRENT');
  for (const configuredPause of [false, true]) for (const status of [undefined, 'PAUSED', 'RESUMED', 'UNAVAILABLE'] as const) {
    f.input.configuredPause = configuredPause;
    f.input.operatorControl = status === undefined ? undefined : { status, version: status === 'UNAVAILABLE' ? null : 1 };
    const result = await f.app.inject(url);
    assert.equal(result.statusCode, status === 'UNAVAILABLE' ? 503 : 200);
    assert.deepEqual(result.json(), body(status !== 'UNAVAILABLE'));
  }
  f.input.operatorControl = { status: 'RESUMED', version: 2 }; f.input.autodispatch = false;
  assert.equal((await f.app.inject(url)).statusCode, 503);
  f.input.autodispatch = true; f.input.stopped = true;
  assert.equal((await f.app.inject(url)).statusCode, 503);
});

test('source errors and inconsistent snapshots cannot leak details or become ready', async t => {
  const f = fixture(); t.after(() => f.app.close()); f.health.record('CURRENT');
  const valid = runtimeSnapshot({ ...f.input, health: f.health.snapshot() });
  const sources: (() => StocksRuntimeSnapshot)[] = [
    () => { throw Object.assign(new Error('PRIVATE_RPC_TOKEN'), { statusCode: 200 }); },
    ...[null, {}, { ...valid, executionAuthorization: true }, { ...valid, pauseReasons: ['OPERATOR_PAUSE'] },
      { ...valid, operatorControl: { status: 'RESUMED', version: null } },
      { ...valid, lastCurrentAgeMs: 60001 }, { ...valid, observerStatus: 'CURRENT', lastCurrentAt: null },
    ].map(raw => () => raw as StocksRuntimeSnapshot),
    () => Object.defineProperty({ ...valid }, 'observerStatus', { get() { throw new Error('PRIVATE_DB_URL'); } }),
  ];
  for (const source of sources) {
    f.source(source); const result = await f.app.inject(url);
    assert.equal(result.statusCode, 503); assert.deepEqual(result.json(), body(false));
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.equal(f.calls(), sources.length);
});

test('probe rejects refresh queries and payloads before snapshot and does not add permissive CORS', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const request of [{ url: `${url}?refresh=true` }, { url, payload: {} },
    { url, headers: { 'content-type': 'application/json' }, payload: '{invalid' },
    { url, headers: { 'transfer-encoding': 'chunked' }, payload: 'x' }]) {
    const result = await f.app.inject({ method: 'GET', ...request });
    assert.equal(result.statusCode, 400); assert.deepEqual(result.json(), body(false));
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.equal(f.calls(), 0);
  const post = await f.app.inject({ method: 'POST', url });
  assert.equal(post.statusCode, 404); assert.equal(f.calls(), 0);
  for (const origin of ['https://stocks.local.test', 'https://evil.test']) {
    const result = await f.app.inject({ method: 'OPTIONS', url, headers: { origin, 'access-control-request-method': 'GET' } });
    assert.notEqual(result.headers['access-control-allow-origin'], '*');
    if (origin === 'https://stocks.local.test') assert.equal(result.headers['access-control-allow-origin'], origin);
    else assert.notEqual(result.headers['access-control-allow-origin'], origin);
  }
});
