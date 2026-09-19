import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { PROFILE } from '../stocks/contracts.js';
import { stocksSessionResolvers, type NamedOperator } from '../stocks-runtime/session.js';
import { a } from '../stocks/test-fixtures.js';
import type { TradingControlChange, TradingControlPort, TradingControlState } from './contracts.js';

const { sign } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
const domain = 'trading-control.local.test', wallet = a(42);
const env: AppEnv = { corsAllowedOrigins: [`https://${domain}`], authNonceTtlSeconds: 60, authJwtSecret: 'TEST_ONLY_TRADING_CONTROL_AUTH_SECRET', adminOperatorToken: 'TEST_ONLY_LEGACY_OPERATOR', registryPath: '/NO_REGISTRY' };
const token = (fields = {}, expiresIn = 900) => sign({ sub: wallet, domain, chainId: 91342, ...fields }, env.authJwtSecret, { expiresIn });
const path = '/api/v1/admin/stocks/trading-control';
const command = { paused: false, expectedVersion: 0, idempotencyKey: 'resume-control-1', reason: 'Verified local reconciliation' };
const initial: TradingControlState = { deploymentDigest: 'a'.repeat(64), paused: true, version: 0, updatedAt: null, operatorId: null, reason: null };

function fixture(enabled = true, operators: NamedOperator[] = [{ wallet, operatorId: 'named-controller', permissions: ['stocks:read', 'stocks:control'] }]) {
  const calls: Array<{ method: string; operatorId?: string }> = [];
  const service: TradingControlPort = {
    async read() { calls.push({ method: 'read' }); return initial; },
    async history() { calls.push({ method: 'history' }); return { items: [], nextBeforeVersion: null }; },
    async change(operator, input): Promise<TradingControlChange> {
      calls.push({ method: 'change', operatorId: operator.operatorId });
      const createdAt = '2026-09-19T00:00:00.000Z';
      const change = { id: 'fixture-control-event', deploymentDigest: initial.deploymentDigest, version: input.expectedVersion + 1, previousPaused: true, paused: input.paused, operatorId: operator.operatorId, reason: input.reason, createdAt };
      return { state: { deploymentDigest: initial.deploymentDigest, paused: input.paused, version: change.version, operatorId: operator.operatorId, reason: input.reason, updatedAt: createdAt }, change, replayed: false };
    },
  };
  const base = { arco: {}, registry: { listNetworks: async () => [] }, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) } } as unknown as ArcoAppServices;
  const app = buildApp(env, { ...base, stocksTradingControl: enabled ? { ...stocksSessionResolvers(env.authJwtSecret, [domain], operators), service } : undefined });
  return { app, calls };
}
function forbidden(response: { statusCode: number; headers: Record<string, unknown>; json(): any }) {
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = response.json();
  assert.equal(new Date(body.observedAt).toISOString(), body.observedAt);
  assert.deepEqual(body, { ...PROFILE, observedAt: body.observedAt, data: null, error: 'OPERATOR_FORBIDDEN' });
}

test('control service absent leaves all control routes404 and existing app routes operational', async t => {
  const { app, calls } = fixture(false); t.after(() => app.close());
  for (const [method, url] of [['GET', path], ['GET', `${path}/history`], ['POST', path]] as const) assert.equal((await app.inject({ method, url, ...(method === 'POST' ? { payload: command } : {}) })).statusCode, 404);
  assert.equal((await app.inject('/api/v1/evm/networks')).statusCode, 200);
  assert.deepEqual(calls, []);
});

test('signed app authority rejects forged identity, legacy credentials, expired and wrong-scope sessions before service', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  const forged = sign({ sub: wallet, domain, chainId: 91342 }, 'WRONG_TEST_ONLY_SECRET', { expiresIn: 900 });
  for (const headers of [
    {}, { 'x-operator-token': env.adminOperatorToken, 'x-role': 'admin', 'x-operator-id': 'named-controller' },
    { authorization: `Bearer ${env.adminOperatorToken}` }, { authorization: `Bearer ${forged}` },
    { authorization: `Bearer ${token({ sub: a(43), role: 'admin', permissions: ['stocks:read', 'stocks:control'], operatorId: 'named-controller' })}` },
    { authorization: `Bearer ${token({ chainId: 1 })}` }, { authorization: `Bearer ${token({ domain: 'other.test' })}` },
    { authorization: `Bearer ${token({}, -1)}` }, { authorization: `Bearer ${token({}, 901)}` },
    { authorization: `Bearer ${token({ iat: Math.floor(Date.now() / 1000) + 30 })}` },
  ]) {
    for (const [method, url] of [['GET', `${path}?invalid=1`], ['GET', `${path}/history?limit=bad`], ['POST', path]] as const) {
      forbidden(await app.inject({ method, url, headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { payload: '{broken' } : {}) }));
    }
  }
  assert.deepEqual(calls, []);
});

test('directory read-only operator cannot POST even when signed claims and browser body claim control', async t => {
  const { app, calls } = fixture(true, [{ wallet, operatorId: 'named-reader', permissions: ['stocks:read'] }]); t.after(() => app.close());
  const headers = { authorization: `Bearer ${token({ permissions: ['stocks:control'], role: 'admin' })}`, 'x-role': 'admin' };
  forbidden(await app.inject({ method: 'POST', url: path, headers, payload: { ...command, permissions: ['stocks:control'], operatorId: 'named-controller' } }));
  assert.deepEqual(calls, []);
  for (const url of [path, `${path}/history`]) {
    const response = await app.inject({ url, headers }); assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().data.executionAuthorization, false); assert.equal(response.json().data.inFlightMayContinue, true);
  }
  assert.deepEqual(calls, [{ method: 'read' }, { method: 'history' }]);
});

test('directory control permission allows POST but GET separately requires stocks:read', async t => {
  const { app, calls } = fixture(true, [{ wallet, operatorId: 'named-controller', permissions: ['stocks:control'] }]); t.after(() => app.close());
  const headers = { authorization: `Bearer ${token({ permissions: ['stocks:read'] })}` };
  for (const url of [path, `${path}/history`]) forbidden(await app.inject({ url, headers }));
  assert.deepEqual(calls, []);
  const response = await app.inject({ method: 'POST', url: path, headers, payload: command });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json().data.state.paused, false); assert.equal(response.json().data.change.operatorId, 'named-controller');
  assert.equal(response.json().data.executionAuthorization, false); assert.equal(response.json().data.inFlightMayContinue, true);
  assert.deepEqual(calls, [{ method: 'change', operatorId: 'named-controller' }]);
});

test('actual app applies explicit CORS, rejects authorized input errors before service and omits credential errors', async t => {
  const { app, calls } = fixture(); t.after(() => app.close());
  for (const origin of [`https://${domain}`, 'https://evil.test']) {
    const response = await app.inject({ method: 'OPTIONS', url: path, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    assert.notEqual(response.headers['access-control-allow-origin'], '*');
    if (origin === `https://${domain}`) assert.equal(response.headers['access-control-allow-origin'], origin);
    else assert.notEqual(response.headers['access-control-allow-origin'], origin);
  }
  const headers = { authorization: `Bearer ${token()}` };
  for (const request of [
    { method: 'GET' as const, url: `${path}?limit=1`, headers },
    { method: 'GET' as const, url: `${path}/history?limit=101`, headers },
    { method: 'GET' as const, url: path, headers, payload: {} },
    { method: 'POST' as const, url: path, headers, payload: { ...command, role: 'admin' } },
    { method: 'POST' as const, url: path, headers: { ...headers, 'content-type': 'application/json' }, payload: '{broken' },
  ]) {
    const response = await app.inject(request); assert.equal(response.statusCode, 400); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().error, 'INVALID_TRADING_CONTROL_INPUT'); assert.equal(response.json().data, null);
    assert.doesNotMatch(response.body, /TEST_ONLY|PRIVATE|Bearer/);
  }
  assert.deepEqual(calls, []);
});
