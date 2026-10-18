import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { adminRouteInventory, buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';
import { a } from '../stocks/test-fixtures.js';
import { parseAdminOperators } from './operators.js';

const { sign } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
const SECRET = 'TEST_ONLY_ADMIN_GUARD_SECRET', LEGACY = 'TEST_ONLY_ADMIN_GUARD_LEGACY', DOMAIN = 'admin.example.test';
const now = () => Math.floor(Date.now() / 1000);
const bearer = (payload: Record<string, unknown>) => ({ authorization: `Bearer ${sign({ domain: DOMAIN, chainId: 91342, ...payload }, SECRET)}` });

// Every service is a tripwire: reaching one means a route ran its handler before (or without)
// an authority check.
function tripwire(path: string, calls: string[]): unknown {
  return new Proxy(function tripwireTarget() {}, {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return tripwire(`${path}.${property}`, calls);
    },
    apply() { calls.push(path); throw new Error(`TRIPWIRE ${path}`); },
    construct() { calls.push(path); throw new Error(`TRIPWIRE ${path}`); },
  });
}

function guardedApp(legacyTokenAuth: boolean) {
  const calls: string[] = [];
  const wire = (path: string) => tripwire(path, calls);
  // Operators exist in both directories, but none of the probing wallets is one of them.
  const resolvers = stocksSessionResolvers(SECRET, [DOMAIN], [{ wallet: a(70), operatorId: 'stocks-operator', permissions: ['stocks:read', 'stocks:control'] }]);
  const env: AppEnv = {
    corsAllowedOrigins: [`https://${DOMAIN}`], authNonceTtlSeconds: 60, authJwtSecret: SECRET, registryPath: '/NO_REGISTRY',
    adminOperators: parseAdminOperators([{ wallet: a(71), operatorId: 'vault-operator', permissions: ['vault:read', 'vault:write'] }]),
    adminOperatorToken: LEGACY, adminLegacyTokenAuth: legacyTokenAuth,
  };
  const services = {
    arco: wire('arco'), registry: wire('registry'), portfolio: wire('portfolio'), readiness: wire('readiness'),
    market: wire('market'), monitoring: wire('monitoring'), register: wire('register'),
    readPauseState: wire('readPauseState'), readVaultLimits: wire('readVaultLimits'), loadRegistry: wire('loadRegistry'),
    arcoUSDAdmin: wire('arcoUSDAdmin'),
    resolveStocksOperator: resolvers.resolveOperator,
    stocks: { service: wire('stocks.service'), resolveActor: resolvers.resolveActor, resolveOperator: resolvers.resolveOperator, reconciliationCoverage: wire('stocks.coverage') },
    stocksRuntimeStatus: { getSnapshot: wire('runtime.getSnapshot'), resolveOperator: resolvers.resolveOperator },
    stocksTradingControl: { service: wire('control'), resolveOperator: resolvers.resolveOperator },
    stocksTradingLimits: { service: { symbols: ['NVDA'], read: wire('limits.read'), change: wire('limits.change'), history: wire('limits.history') }, resolveOperator: resolvers.resolveOperator },
    stocksSubmissionDiagnostics: { service: wire('diagnostics'), resolveOperator: resolvers.resolveOperator },
    adminAudit: () => {},
  } as unknown as ArcoAppServices;
  return { app: buildApp(env, services), calls };
}

const PARAMS: Record<string, string> = {
  chainId: '91342', productId: 'acapix', id: 'card-1', address: a(72), requestId: '1', side: 'BUY', orderId: 'order-1', symbol: 'NVDA',
};
const concrete = (url: string) => url.replace(/:([A-Za-z]+)/g, (_match, name: string) => PARAMS[name] ?? 'x');
const isStocks = (url: string) => url.startsWith('/api/v1/admin/stocks/');
const SESSION_ROUTE = '/api/v1/admin/session';

// If one of these disappears (or the inventory stops seeing plugin routes) the test fails
// rather than passing over an empty list.
const KNOWN = [
  'GET /api/v1/admin/session',
  'POST /api/v1/admin/wallets/:address/greenlist',
  'POST /api/v1/admin/products/:productId/price',
  'GET /api/v1/admin/products/:productId/limits',
  'GET /api/v1/admin/products/:productId/feeds',
  'GET /api/v1/admin/redemptions/pending',
  'GET /api/v1/admin/arcousd/snapshots',
  'GET /api/v1/admin/arcousd/queue',
  'GET /api/v1/admin/arcousd/flows',
  'POST /api/v1/admin/arcousd/process-queue',
  'GET /api/v1/admin/pause-state',
  'POST /api/v1/admin/products/:productId/withdraw',
  'POST /api/v1/admin/products/:productId/redemptions/:requestId/payout',
  'POST /api/v1/admin/redemptions/:requestId/:action',
  'GET /api/v1/admin/monitoring/:chainId/overview',
  'POST /api/v1/admin/registry/register-product',
  'GET /api/v1/admin/vault-config/:chainId',
  'PUT /api/v1/admin/vault-config/:chainId/:productId',
  'PUT /api/v1/admin/savings-order/:chainId',
  'POST /api/v1/admin/featured/:chainId',
  'DELETE /api/v1/admin/featured/:chainId/:id',
  'GET /api/v1/admin/stocks/overview',
  'GET /api/v1/admin/stocks/orders',
  'GET /api/v1/admin/stocks/orders/:id',
  'GET /api/v1/admin/stocks/reconciliations',
  'GET /api/v1/admin/stocks/audit',
  'GET /api/v1/admin/stocks/held',
  'GET /api/v1/admin/stocks/runtime',
  'GET /api/v1/admin/stocks/trading-control',
  'POST /api/v1/admin/stocks/trading-control',
  'GET /api/v1/admin/stocks/trading-control/history',
  'GET /api/v1/admin/stocks/limits',
  'GET /api/v1/admin/stocks/limits/history',
  'PUT /api/v1/admin/stocks/limits/:symbol/:side',
  'GET /api/v1/admin/stocks/wallet-submissions/:side/:orderId',
];

test('every /api/v1/admin/* route is recorded, and every non-Stocks one carries the tagged authority guard', async t => {
  const { app, calls } = guardedApp(false); t.after(() => app.close());
  await app.ready();
  const routes = adminRouteInventory(app);
  const seen = new Set(routes.map(route => `${route.method} ${route.url}`));
  for (const route of KNOWN) assert.ok(seen.has(route), `inventory is missing ${route}`);
  for (const route of routes) {
    if (isStocks(route.url)) continue; // guarded inside the Stocks plugins; proven behaviorally below
    assert.equal(route.guard, route.url === SESSION_ROUTE ? 'session' : 'vault', `${route.method} ${route.url} has no admin guard`);
  }
  assert.deepEqual(calls, []);
});

test('no admin route answers, or touches a service, without an authorized operator', async t => {
  const { app, calls } = guardedApp(false); t.after(() => app.close());
  await app.ready();
  const routes = adminRouteInventory(app);
  assert.ok(routes.length >= KNOWN.length);
  const credentials: Record<string, Record<string, string>> = {
    none: {},
    expired: bearer({ sub: a(73), iat: now() - 1000, exp: now() - 100 }),
    foreignDomain: bearer({ sub: a(71), domain: 'evil.example.test', iat: now(), exp: now() + 900 }),
    notAnOperator: bearer({ sub: a(73), iat: now(), exp: now() + 900 }),
    legacyTokenDisabled: { 'x-operator-token': LEGACY },
    claimedRole: { 'x-role': 'admin', 'x-wallet': a(71), 'x-operator-id': 'vault-operator' },
  };
  for (const route of routes) {
    for (const [name, headers] of Object.entries(credentials)) {
      // A valid session is exactly what /session describes (200 with no permissions).
      if (route.url === SESSION_ROUTE && name === 'notAnOperator') continue;
      const write = route.method !== 'GET' && route.method !== 'HEAD';
      const response = await app.inject({ method: route.method as 'GET', url: concrete(route.url), headers, ...(write ? { payload: {} } : {}) });
      assert.ok([401, 403].includes(response.statusCode), `${route.method} ${route.url} answered ${response.statusCode} to ${name}`);
    }
  }
  assert.deepEqual(calls, [], 'a route reached a service before authorization');
});

test('with ADMIN_LEGACY_TOKEN_AUTH=1 the shared token still opens no Stocks route and no session', async t => {
  const { app, calls } = guardedApp(true); t.after(() => app.close());
  await app.ready();
  const routes = adminRouteInventory(app).filter(route => isStocks(route.url) || route.url === SESSION_ROUTE);
  assert.ok(routes.some(route => isStocks(route.url)));
  for (const route of routes) {
    const write = route.method !== 'GET' && route.method !== 'HEAD';
    const response = await app.inject({ method: route.method as 'GET', url: concrete(route.url), headers: { 'x-operator-token': LEGACY }, ...(write ? { payload: {} } : {}) });
    assert.ok([401, 403].includes(response.statusCode), `${route.method} ${route.url} accepted the legacy token (${response.statusCode})`);
  }
  assert.deepEqual(calls, []);
});
