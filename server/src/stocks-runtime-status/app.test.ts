import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';
import { StocksObservationHealth } from '../stocks-runtime/health.js';
import { runtimeSnapshot } from '../stocks-runtime/status.js';
import { a } from '../stocks/test-fixtures.js';
const { sign } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
const domain = 'runtime.local.test', wallet = a(42);
const env: AppEnv = { corsAllowedOrigins: [`https://${domain}`], authNonceTtlSeconds: 60, authJwtSecret: 'TEST_ONLY_RUNTIME_AUTH_SECRET', adminOperatorToken: 'TEST_ONLY_OPERATOR', registryPath: '/NO_REGISTRY' };
const token = (fields = {}) => sign({ sub: wallet, domain, chainId: 91342, ...fields }, env.authJwtSecret, { expiresIn: '15m' });
const path = '/api/v1/admin/stocks/runtime';
function fixture(enabled = true) {
  let calls = 0, wall = Date.now(), mono = 0;
  const health = new StocksObservationHealth(() => wall, () => mono);
  const base = { arco: {}, registry: { listNetworks: async () => [] }, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) } } as unknown as ArcoAppServices;
  const app = buildApp(env, { ...base, stocksRuntimeStatus: enabled ? {
    ...stocksSessionResolvers(env.authJwtSecret, [domain], [{ wallet, operatorId: 'named-reader', permissions: ['stocks:read'] }]),
    getSnapshot: () => { calls++; return runtimeSnapshot({ deploymentId: 'fixture-deployment', deploymentDigest: 'a'.repeat(64), autodispatch: true, configuredPause: false, stopped: false, tickInFlight: false, health: health.snapshot() }); },
  } : undefined });
  return { app, health, calls: () => calls, advance: (ms: number) => { wall += ms; mono += ms; } };
}
test('runtime status route absent without runtime, legacy routes unchanged', async t => {
  const { app } = fixture(false); t.after(() => app.close());
  assert.equal((await app.inject(path)).statusCode, 404);
  assert.equal((await app.inject('/api/v1/evm/networks')).statusCode, 200);
});
test('actual app requires signed named operator and denies claimed roles/legacy token/wrong scope before snapshot', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const headers of [{}, { 'x-operator-token': env.adminOperatorToken }, { authorization: `Bearer ${env.adminOperatorToken}` }, { authorization: `Bearer ${token({ sub: a(43), role: 'admin', permissions: ['stocks:read'] })}` }, { authorization: `Bearer ${token({ chainId: 1 })}` }, { authorization: `Bearer ${token({ domain: 'evil.test' })}` }]) {
    const response = await f.app.inject({ url: path, headers });
    assert.equal(response.statusCode, 403); assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(f.calls(), 0);
  const headers = { authorization: `Bearer ${token()}` };
  let response = await f.app.inject({ url: path, headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json().data.observerStatus, 'STARTING');
  f.health.record('CURRENT');
  response = await f.app.inject({ url: path, headers });
  assert.equal(response.json().data.newOrdersPaused, false); assert.equal(response.json().data.executionAuthorization, false);
  assert.equal(response.json().profile, 'DEMO_TESTNET'); assert.equal(response.json().data.observedAt, undefined);
  f.advance(60001);
  response = await f.app.inject({ url: path, headers });
  assert.equal(response.json().data.observerStatus, 'STALE'); assert.equal(response.json().data.newOrdersPaused, true);
  assert.equal(f.calls(), 3);
});
test('runtime status inherits explicit CORS and rejects payload/query without invoking snapshot', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const origin of [`https://${domain}`, 'https://evil.test']) {
    const response = await f.app.inject({ method: 'OPTIONS', url: path, headers: { origin, 'access-control-request-method': 'GET' } });
    assert.notEqual(response.headers['access-control-allow-origin'], '*');
    if (origin === `https://${domain}`) assert.equal(response.headers['access-control-allow-origin'], origin);
    else assert.notEqual(response.headers['access-control-allow-origin'], origin);
  }
  const headers = { authorization: `Bearer ${token()}` };
  for (const request of [{ url: `${path}?refresh=true`, headers }, { url: path, headers, payload: {} }]) {
    const response = await f.app.inject({ method: 'GET', ...request }); assert.equal(response.statusCode, 400); assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(f.calls(), 0);
});
