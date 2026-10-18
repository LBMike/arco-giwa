import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { stocksSessionResolvers, type NamedOperator } from '../stocks-runtime/session.js';
import { a } from '../stocks/test-fixtures.js';
import type { TradingControlChange, TradingControlPort, TradingControlState } from '../stocks-trading-control/contracts.js';
import type { AdminAuditEntry } from './audit.js';
import { parseAdminOperators } from './operators.js';

const { sign } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
const SECRET = 'TEST_ONLY_ADMIN_AUTH_SECRET';
const LEGACY = 'TEST_ONLY_LEGACY_OPERATOR_TOKEN';
const ADMIN_DOMAIN = 'admin.example.test', APP_DOMAIN = 'app.example.test';
const W = { reader: a(21), writer: a(22), full: a(23), stocks: a(24), both: a(25), stranger: a(26) };
const VAULT_OPERATORS = parseAdminOperators([
  { wallet: W.reader, operatorId: 'vault-reader', permissions: ['vault:read'] },
  { wallet: W.writer, operatorId: 'vault-writer', permissions: ['vault:write'] },
  { wallet: W.full, operatorId: 'vault-full', permissions: ['vault:read', 'vault:write'] },
  { wallet: W.both, operatorId: 'ops-both', permissions: ['vault:read', 'vault:write'] },
]);
const STOCKS_OPERATORS: NamedOperator[] = [
  { wallet: W.stocks, operatorId: 'stocks-controller', permissions: ['stocks:read', 'stocks:control'] },
  { wallet: W.both, operatorId: 'ops-both-stocks', permissions: ['stocks:read'] },
];

const jwt = (payload: Record<string, unknown>, secret = SECRET) => sign({ domain: ADMIN_DOMAIN, chainId: 91342, ...payload }, secret);
const now = () => Math.floor(Date.now() / 1000);
const session = (wallet: string, fields: Record<string, unknown> = {}) =>
  ({ authorization: `Bearer ${jwt({ sub: wallet, iat: now(), exp: now() + 900, ...fields })}` });
const expired = (wallet: string) => ({ authorization: `Bearer ${jwt({ sub: wallet, iat: now() - 1000, exp: now() - 100 })}` });
const legacy = (token = LEGACY) => ({ 'x-operator-token': token });

const READ = { method: 'GET', url: '/api/v1/admin/redemptions/pending' } as const;
const WRITE = { method: 'POST', url: '/api/v1/admin/products/acapix/redemptions/7/release' } as const;
const DELETE = { method: 'DELETE', url: '/api/v1/admin/featured/91342/card-1' } as const;
const SESSION = { method: 'GET', url: '/api/v1/admin/session' } as const;
const STOCKS_READ = { method: 'GET', url: '/api/v1/admin/stocks/trading-control' } as const;
const STOCKS_WRITE = {
  method: 'POST', url: '/api/v1/admin/stocks/trading-control',
  payload: { paused: false, expectedVersion: 0, idempotencyKey: 'resume-control-1', reason: 'Verified reconciliation' },
} as const;

const initial: TradingControlState = { deploymentDigest: 'a'.repeat(64), paused: true, version: 0, updatedAt: null, operatorId: null, reason: null };

function fixture(options: { legacy?: boolean; stocks?: boolean } = {}) {
  const calls: string[] = [];
  const audit: AdminAuditEntry[] = [];
  const record = <T>(name: string, value: T) => async () => { calls.push(name); return value; };
  const arco = {
    pendingRedemptions: record('pendingRedemptions', []),
    markRedemptionReleased: record('markRedemptionReleased', { count: 1 }),
    featuredCards: record('featuredCards', [{ id: 'card-1' }]),
    deleteFeaturedCard: record('deleteFeaturedCard', undefined),
  };
  const control: TradingControlPort = {
    async read() { calls.push('control.read'); return initial; },
    async history() { calls.push('control.history'); return { items: [], nextBeforeVersion: null }; },
    async change(operator, input): Promise<TradingControlChange> {
      calls.push('control.change');
      const createdAt = '2026-09-26T00:00:00.000Z';
      const change = { id: 'control-event-1', deploymentDigest: initial.deploymentDigest, version: input.expectedVersion + 1, previousPaused: true, paused: input.paused, operatorId: operator.operatorId, reason: input.reason, createdAt };
      return { state: { deploymentDigest: initial.deploymentDigest, paused: input.paused, version: change.version, operatorId: operator.operatorId, reason: input.reason, updatedAt: createdAt }, change, replayed: false };
    },
  };
  const env: AppEnv = {
    corsAllowedOrigins: [`https://${ADMIN_DOMAIN}`, `https://${APP_DOMAIN}`], authNonceTtlSeconds: 60, authJwtSecret: SECRET,
    registryPath: '/NO_REGISTRY', adminOperators: VAULT_OPERATORS, adminOperatorToken: LEGACY, adminLegacyTokenAuth: options.legacy ?? false,
  };
  const stocks = stocksSessionResolvers(SECRET, [ADMIN_DOMAIN, APP_DOMAIN], STOCKS_OPERATORS);
  const services = {
    arco, registry: { listNetworks: async () => [] }, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) },
    // Product-scoped redemption routes resolve the redemption vault from the registry.
    loadRegistry: () => ({ chainId: 91342, assets: [], products: [{ productId: 'acapix', paymentAssetSymbol: 'tUSDC', redemptionVault: { proxy: '0x00000000000000000000000000000000000000a1' } }] }),
    adminAudit: (entry: AdminAuditEntry) => { audit.push(entry); },
    ...(options.stocks === false ? {} : {
      resolveStocksOperator: stocks.resolveOperator,
      stocksTradingControl: { service: control, resolveOperator: stocks.resolveOperator },
    }),
  } as unknown as ArcoAppServices;
  const app = buildApp(env, services);
  const call = async (route: { method: string; url: string; payload?: unknown }, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method: route.method as 'GET', url: route.url, headers, ...(route.payload ? { payload: route.payload as object } : {}) });
    // The audit line is written after the response; let it land before the next request.
    await new Promise(resolve => setImmediate(resolve));
    return response;
  };
  return { app, calls, audit, call };
}

test('no session, an expired session or any invalid session is 401 on reads, writes and /session', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const now_ = now();
  const invalid = [
    {}, expired(W.full), { authorization: 'Bearer not-a-session' }, { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` },
    { authorization: `Bearer ${jwt({ sub: W.full, iat: now_, exp: now_ + 900 }, 'WRONG_TEST_ONLY_SECRET')}` },
    session(W.full, { domain: 'evil.example.test' }), session(W.full, { chainId: 1 }),
    session(W.full, { exp: now_ + 3600 }), session(W.full, { iat: now_ + 60 }),
  ];
  for (const headers of invalid) {
    for (const route of [READ, WRITE, DELETE, SESSION]) {
      const response = await f.call(route, headers as Record<string, string>);
      assert.equal(response.statusCode, 401, `${route.method} ${route.url} ${JSON.stringify(headers)}`);
      assert.equal(response.json().code, 'SESSION_REQUIRED');
    }
  }
  assert.deepEqual(f.calls, []);
});

test('a signed-in wallet outside ADMIN_OPERATORS is 403 on every Vault route; /session still answers with no permissions', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const route of [READ, WRITE, DELETE]) {
    const response = await f.call(route, session(W.stranger));
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'OPERATOR_FORBIDDEN');
  }
  assert.deepEqual(f.calls, []);
  const me = await f.call(SESSION, session(W.stranger));
  assert.equal(me.statusCode, 200);
  assert.equal(me.headers['cache-control'], 'no-store');
  assert.deepEqual(me.json(), { wallet: W.stranger, vault: null, stocks: null });
});

test('vault:read reads only, vault:write writes only, and both together do both', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const expect = async (wallet: string, read: number, write: number) => {
    assert.equal((await f.call(READ, session(wallet))).statusCode, read);
    assert.equal((await f.call(WRITE, session(wallet))).statusCode, write);
    assert.equal((await f.call(DELETE, session(wallet))).statusCode, write);
  };
  await expect(W.reader, 200, 403);
  const denied = await f.call(WRITE, session(W.reader));
  assert.deepEqual(denied.json(), { error: 'This operator lacks vault:write.', code: 'PERMISSION_REQUIRED' });
  await expect(W.writer, 403, 200);
  await expect(W.full, 200, 200);
  // Mixed-case wallets in the session are the same operator.
  assert.equal((await f.call(READ, session(W.full.toUpperCase().replace('0X', '0x')))).statusCode, 200);
});

test('Vault permissions never reach Stocks routes and Stocks permissions never reach Vault routes', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const route of [STOCKS_READ, STOCKS_WRITE]) assert.equal((await f.call(route, session(W.full))).statusCode, 403);
  for (const route of [READ, WRITE, DELETE]) assert.equal((await f.call(route, session(W.stocks))).statusCode, 403);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.call(STOCKS_READ, session(W.stocks))).statusCode, 200);
  assert.deepEqual((await f.call(SESSION, session(W.stocks))).json(),
    { wallet: W.stocks, vault: null, stocks: { operatorId: 'stocks-controller', permissions: ['stocks:read', 'stocks:control'] } });
  assert.deepEqual((await f.call(SESSION, session(W.both))).json(), {
    wallet: W.both,
    vault: { operatorId: 'ops-both', permissions: ['vault:read', 'vault:write'] },
    stocks: { operatorId: 'ops-both-stocks', permissions: ['stocks:read'] },
  });
});

test('the legacy shared token is refused by default', async t => {
  const f = fixture(); t.after(() => f.app.close());
  for (const route of [READ, WRITE, DELETE, SESSION]) assert.equal((await f.call(route, legacy())).statusCode, 401);
  assert.deepEqual(f.calls, []);
});

test('ADMIN_LEGACY_TOKEN_AUTH=1 accepts the exact token on Vault routes only, never on Stocks or /session', async t => {
  const f = fixture({ legacy: true }); t.after(() => f.app.close());
  for (const route of [READ, WRITE, DELETE]) assert.equal((await f.call(route, legacy())).statusCode, 200);
  for (const token of [`${LEGACY}x`, LEGACY.slice(0, -1), LEGACY.toLowerCase(), ' ', 'x'.repeat(5000)]) {
    assert.equal((await f.call(READ, legacy(token))).statusCode, 401);
  }
  for (const route of [STOCKS_READ, STOCKS_WRITE]) assert.equal((await f.call(route, legacy())).statusCode, 403);
  assert.equal((await f.call(SESSION, legacy())).statusCode, 401);
  // A presented session is authoritative: an expired one never falls back to the token.
  assert.equal((await f.call(READ, { ...expired(W.full), ...legacy() })).statusCode, 401);
  assert.equal((await f.call(READ, { ...session(W.stranger), ...legacy() })).statusCode, 403);
});

test('Vault admin authentication works with the Stocks runtime off', async t => {
  const f = fixture({ stocks: false }); t.after(() => f.app.close());
  assert.equal((await f.call(READ, session(W.full))).statusCode, 200);
  assert.equal((await f.call(WRITE, session(W.full))).statusCode, 200);
  assert.deepEqual((await f.call(SESSION, session(W.both))).json(),
    { wallet: W.both, vault: { operatorId: 'ops-both', permissions: ['vault:read', 'vault:write'] }, stocks: null });
  assert.equal((await f.call(STOCKS_READ, session(W.stocks))).statusCode, 404);
});

test('every admin write attempt is audited with operator identity and never with credentials', async t => {
  const f = fixture({ legacy: true }); t.after(() => f.app.close());
  const writerSession = session(W.writer), strangerSession = session(W.stranger), stocksSession = session(W.stocks);
  await f.call(READ, session(W.full));
  await f.call(WRITE, writerSession);
  await f.call(WRITE, strangerSession);
  await f.call(WRITE);
  await f.call(DELETE, legacy());
  await f.call(STOCKS_WRITE, stocksSession);
  await f.call(STOCKS_WRITE, session(W.full));
  const summary = f.audit.map(({ scope, method, route, statusCode, operatorId, wallet, via }) => ({ scope, method, route, statusCode, operatorId, wallet, via }));
  assert.deepEqual(summary, [
    { scope: 'vault', method: 'POST', route: '/api/v1/admin/products/:productId/redemptions/:requestId/release', statusCode: 200, operatorId: 'vault-writer', wallet: W.writer, via: 'session' },
    { scope: 'vault', method: 'POST', route: '/api/v1/admin/products/:productId/redemptions/:requestId/release', statusCode: 403, operatorId: null, wallet: W.stranger, via: 'session' },
    { scope: 'vault', method: 'POST', route: '/api/v1/admin/products/:productId/redemptions/:requestId/release', statusCode: 401, operatorId: null, wallet: null, via: null },
    { scope: 'vault', method: 'DELETE', route: '/api/v1/admin/featured/:chainId/:id', statusCode: 200, operatorId: 'legacy-operator-token', wallet: null, via: 'legacy-token' },
    { scope: 'stocks', method: 'POST', route: '/api/v1/admin/stocks/trading-control', statusCode: 200, operatorId: 'stocks-controller', wallet: W.stocks, via: 'session' },
    { scope: 'stocks', method: 'POST', route: '/api/v1/admin/stocks/trading-control', statusCode: 403, operatorId: null, wallet: W.full, via: 'session' },
  ]);
  assert.deepEqual(f.audit[0].params, { productId: 'acapix', requestId: '7' });
  for (const entry of f.audit) {
    assert.equal(entry.service, 'arco-giwa-api');
    assert.equal(entry.event, 'admin.write');
    assert.equal(new Date(entry.at).toISOString(), entry.at);
  }
  const logged = JSON.stringify(f.audit);
  for (const secret of [SECRET, LEGACY, 'Bearer', 'eyJ', writerSession.authorization.slice(7), stocksSession.authorization.slice(7)]) {
    assert.equal(logged.includes(secret), false, 'audit log must not contain credentials');
  }
});
