import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';
import type { StocksExecutionService } from '../stocks-execution/service.js';
import { a } from '../stocks/test-fixtures.js';
const { sign } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
const domain = 'execution.local.test', wallet = a(42);
const env: AppEnv = { corsAllowedOrigins: [`https://${domain}`], authNonceTtlSeconds: 60, authJwtSecret: 'TEST_ONLY_EXECUTION_AUTH_SECRET', adminOperatorToken: 'TEST_ONLY_OPERATOR', registryPath: '/NO_REGISTRY' };
const token = (fields = {}) => sign({ sub: wallet, domain, chainId: 91342, ...fields }, env.authJwtSecret, { expiresIn: '15m' });
function fixture(enabled = true) {
  const calls: unknown[] = [];
  const service = { deployment: async (actor: unknown) => { calls.push(actor); return { status: 'VERIFIED' }; }, policy: async (actor: unknown, side: unknown, order: unknown) => { calls.push({ actor, side, order }); return { allowed: true }; } } as unknown as StocksExecutionService;
  const base = { arco: {}, registry: { listNetworks: async () => [] }, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) } } as unknown as ArcoAppServices;
  const app = buildApp(env, { ...base, stocksExecution: enabled ? { service, ...stocksSessionResolvers(env.authJwtSecret, [domain], []) } : undefined });
  return { app, calls };
}
const paths = ['/api/v1/stocks/execution/deployment', '/api/v1/stocks/execution/BUY/order-test'];
test('execution routes are optional and legacy network route remains available', async () => {
  const { app } = fixture(false);
  try { for (const url of paths) assert.equal((await app.inject(url)).statusCode, 404); assert.equal((await app.inject('/api/v1/evm/networks')).statusCode, 200); }
  finally { await app.close(); }
});
test('execution app authenticates signed owner and rejects forged headers, chain and domain before invocation', async () => {
  const { app, calls } = fixture();
  try {
    for (const path of paths) {
      for (const headers of [{}, { authorization: `Bearer ${env.adminOperatorToken}` }, { authorization: `Bearer ${token({chainId:1})}` }, { authorization: `Bearer ${token({domain:'evil.test'})}` }, { 'x-wallet': wallet, 'x-role': 'admin' }]) {
        const r = await app.inject({ method: 'GET', url: path, headers }); assert.equal(r.statusCode, 401); assert.equal(r.headers['cache-control'], 'no-store');
      }
    }
    assert.equal(calls.length, 0);
    for (const path of paths) { const r = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token()}` } }); assert.equal(r.statusCode, 200); assert.equal(r.json().chainId, 91342); assert.equal(r.headers['cache-control'], 'no-store'); }
    assert.equal(calls.length, 2); assert.equal((calls[0] as {wallet:string}).wallet, wallet);
  } finally { await app.close(); }
});
test('execution endpoints inherit explicit CORS allowlist without wildcard', async () => {
  const { app } = fixture();
  try {
    for (const origin of [`https://${domain}`, 'https://evil.test']) {
      const r = await app.inject({ method: 'OPTIONS', url: paths[0], headers: { origin, 'access-control-request-method': 'GET' } });
      assert.notEqual(r.headers['access-control-allow-origin'], '*');
      if (origin === `https://${domain}`) assert.equal(r.headers['access-control-allow-origin'], origin); else assert.notEqual(r.headers['access-control-allow-origin'], origin);
    }
  } finally { await app.close(); }
});
