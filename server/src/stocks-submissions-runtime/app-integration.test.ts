import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildApp, type ArcoAppServices, type AppEnv } from '../app.js';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';
import type { StocksSubmissionsService } from '../stocks-submissions/service.js';
import { PROFILE, type Actor } from '../stocks/contracts.js';
import { a } from '../stocks/test-fixtures.js';
const require = createRequire(import.meta.url);
const { sign } = require('jsonwebtoken') as typeof import('jsonwebtoken');
const env: AppEnv = { corsAllowedOrigins: ['https://submissions.local.test'], authNonceTtlSeconds: 60, authJwtSecret: 'LOCAL_TEST_ONLY_SUBMISSIONS_NOT_A_REAL_SECRET', adminOperatorToken: 'LOCAL_TEST_ONLY_LEGACY', registryPath: '/NO_DEPLOYED_REGISTRY' };
const wallet = a(42);
const token = (claims: Record<string, unknown> = {}) => sign({ sub: wallet, chainId: 91342, domain: 'submissions.local.test', ...claims }, env.authJwtSecret, { algorithm: 'HS256', expiresIn: '15m' });
function fixture(enabled = true) {
  const calls: { actor: Actor; side: string; id: string }[] = [];
  const service = { inspect: async (actor: Actor, side: string, id: string) => { calls.push({ actor, side, id }); return { intentKey: 'a'.repeat(64), approval: null, transfer: null }; } } as unknown as StocksSubmissionsService;
  const legacy = { arco: { vaultConfigs: async () => [] }, registry: { listNetworks: async () => [{ chainId: 91342 }] }, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) }, loadRegistry: () => { throw new Error('NO_DEPLOYED_REGISTRY'); } } as unknown as ArcoAppServices;
  const app = buildApp(env, { ...legacy, stocksSubmissions: enabled ? { service, ...stocksSessionResolvers(env.authJwtSecret, ['submissions.local.test'], []) } : undefined });
  return { app, calls };
}
const path = '/api/v1/stocks/wallet-submissions/BUY/order-test-123';
test('submission app wiring is optional and preserves legacy endpoints', async () => {
  const { app } = fixture(false);
  try { assert.equal((await app.inject(path)).statusCode, 404); assert.equal((await app.inject('/api/v1/evm/networks')).statusCode, 200); }
  finally { await app.close(); }
});
test('submission app reuses wallet authentication and rejects legacy operator, wrong chain and wrong domain', async () => {
  const { app, calls } = fixture();
  try {
    for (const headers of [{}, { authorization: `Bearer ${env.adminOperatorToken}` }, { authorization: `Bearer ${token({ chainId: 1 })}` }, { authorization: `Bearer ${token({ domain: 'other.local.test' })}` }]) assert.equal((await app.inject({ method: 'GET', url: path, headers })).statusCode, 401);
    assert.equal(calls.length, 0);
    const response = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token()}` } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().profile, PROFILE.profile);
    assert.deepEqual(calls, [{ actor: { actorId: `evm:${wallet}`, wallet, chainId: 91342, scope: 'STOCKS_TESTNET', verified: true }, side: 'BUY', id: 'order-test-123' }]);
    assert.match(response.headers['cache-control'] ?? '', /no-store/);
  } finally { await app.close(); }
});
test('submission routes inherit the explicit CORS allowlist', async () => {
  const { app } = fixture();
  try {
    const good = await app.inject({ method: 'OPTIONS', url: path, headers: { origin: 'https://submissions.local.test', 'access-control-request-method': 'GET' } });
    assert.equal(good.headers['access-control-allow-origin'], 'https://submissions.local.test');
    const bad = await app.inject({ method: 'OPTIONS', url: path, headers: { origin: 'https://other.local.test', 'access-control-request-method': 'GET' } });
    assert.notEqual(bad.headers['access-control-allow-origin'], '*');
    assert.notEqual(bad.headers['access-control-allow-origin'], 'https://other.local.test');
  } finally { await app.close(); }
});

test('receipt reconciliation is optional and authenticates before parsing or invoking its verifier', async () => {
  const disabled = fixture(false);
  try {
    assert.equal((await disabled.app.inject({ method: 'POST', url: '/api/v1/stocks/wallet-submissions/reconcile', payload: {} })).statusCode, 404);
  } finally { await disabled.app.close(); }
  const { app } = fixture();
  try {
    for (const authorization of ['', `Bearer ${env.adminOperatorToken}`, `Bearer ${token({ chainId: 1 })}`, `Bearer ${token({ domain: 'foreign.test' })}`]) {
      const result = await app.inject({ method: 'POST', url: '/api/v1/stocks/wallet-submissions/reconcile', headers: { authorization, 'content-type': 'application/json' }, payload: '{ malformed json' });
      assert.equal(result.statusCode, 401);
      assert.match(result.headers['cache-control'] ?? '', /no-store/);
    }
  } finally { await app.close(); }
});
