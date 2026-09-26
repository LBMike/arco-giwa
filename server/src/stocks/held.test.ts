import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';
import { parseAdminOperators } from '../admin-auth/operators.js';
import { PROFILE } from './contracts.js';
import { a } from './test-fixtures.js';
import { encodeHeldCursor, HELD_DEFAULT_LIMIT, parseHeldQuery, readHeldPayments } from './held.js';

const DIGEST = 'd'.repeat(64);
const row = (n: number, side: 'BUY' | 'SELL', hold: string | null = null) => ({
  id: `${side === 'BUY' ? 'funding' : 'custody'}-${n}`, side, wallet: a(80 + n),
  cashAmount: side === 'BUY' ? `${n}000000` : null, quantity: side === 'SELL' ? `${n}000000000000000000` : null,
  txHash: `0x${String(n).padStart(64, '0')}`, reason: 'UNIDENTIFIED_ORDER', status: side === 'BUY' ? 'SUSPENSE' : 'HELD',
  createdAt: new Date(Date.UTC(2026, 8, 20, 12, 0, 60 - n)), cursorTime: `2026-09-20T12:00:${String(60 - n).padStart(2, '0')}.123456Z`, hold,
});

function fakePool(rows: Record<string, unknown>[]) {
  const queries: { text: string; values: unknown[] }[] = [];
  return { queries, pool: { query: async (text: string, values: unknown[] = []) => { queries.push({ text, values }); return { rows, rowCount: rows.length }; } } };
}

test('held query: defaults, limits and cursors are validated strictly', () => {
  assert.deepEqual(parseHeldQuery({}), { limit: HELD_DEFAULT_LIMIT, cursor: null });
  assert.deepEqual(parseHeldQuery({ limit: '1' }), { limit: 1, cursor: null });
  assert.deepEqual(parseHeldQuery({ limit: '100' }), { limit: 100, cursor: null });
  const cursor = encodeHeldCursor({ t: '2026-09-20T12:00:01.000001Z', s: 'SELL', i: 'custody-1' });
  assert.deepEqual(parseHeldQuery({ cursor }).cursor, { t: '2026-09-20T12:00:01.000001Z', s: 'SELL', i: 'custody-1' });
  const bad = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const query of [
    null, [], { limit: '0' }, { limit: '101' }, { limit: '001' }, { limit: '1.5' }, { limit: '-1' }, { limit: 'ten' }, { limit: ['1', '2'] },
    { page: '2' }, { cursor: '' }, { cursor: 'not base64!' }, { cursor: 'x'.repeat(513) }, { cursor: Buffer.from('[]').toString('base64url') },
    { cursor: bad({ t: '2026-09-20T12:00:01Z', s: 'BUY', i: 'x' }) }, { cursor: bad({ t: '2026-09-20T12:00:01.000001Z', s: 'HOLD', i: 'x' }) },
    { cursor: bad({ t: '2026-09-20T12:00:01.000001Z', s: 'BUY', i: '' }) }, { cursor: bad({ t: '2026-09-20T12:00:01.000001Z', s: 'BUY', i: 'x', extra: 1 }) },
    { cursor: bad({ t: '2026-02-31T12:00:01.000001Z', s: 'BUY', i: 'x'.repeat(201) }) },
  ]) {
    assert.throws(() => parseHeldQuery(query), { code: 'INVALID_HELD_QUERY', status: 400 }, JSON.stringify(query));
  }
});

test('held payments: one read-only query scoped to the deployment, newest first, one page and a cursor for the next', async () => {
  const { pool, queries } = fakePool([row(1, 'BUY', 'TRADING_PAUSED'), row(2, 'SELL', 'BELOW_ONE_UNIT'), row(3, 'BUY', 'SOMETHING_ELSE')]);
  const first = await readHeldPayments({ pool, deploymentDigest: DIGEST }, { limit: 2, cursor: null });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values, [DIGEST, null, null, null, 3]);
  assert.doesNotMatch(queries[0].text, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/i);
  assert.match(queries[0].text, /"orderId" IS NULL/);
  assert.match(queries[0].text, /DIRECT_ORDER_NOT_CREATED/);
  assert.deepEqual(first.items, [
    { id: 'funding-1', side: 'BUY', wallet: a(81), cashAmount: '1000000', quantity: null, txHash: `0x${'1'.padStart(64, '0')}`, hold: 'TRADING_PAUSED', reason: 'UNIDENTIFIED_ORDER', status: 'SUSPENSE', createdAt: '2026-09-20T12:00:59.000Z' },
    { id: 'custody-2', side: 'SELL', wallet: a(82), cashAmount: null, quantity: '2000000000000000000', txHash: `0x${'2'.padStart(64, '0')}`, hold: 'BELOW_ONE_UNIT', reason: 'UNIDENTIFIED_ORDER', status: 'HELD', createdAt: '2026-09-20T12:00:58.000Z' },
  ]);
  assert.deepEqual(parseHeldQuery({ cursor: first.nextCursor! }).cursor, { t: '2026-09-20T12:00:58.123456Z', s: 'SELL', i: 'custody-2' });

  const last = fakePool([row(3, 'BUY', 'SOMETHING_ELSE')]);
  const next = await readHeldPayments({ pool: last.pool, deploymentDigest: DIGEST }, parseHeldQuery({ limit: '2', cursor: first.nextCursor! }));
  assert.deepEqual(last.queries[0].values, [DIGEST, '2026-09-20T12:00:58.123456Z', 'SELL', 'custody-2', 3]);
  assert.equal(next.items[0].hold, null, 'unknown hold values are not passed through');
  assert.equal(next.nextCursor, null);
});

test('GET /api/v1/admin/stocks/held: stocks:read only, validated, enveloped like the other Stocks admin views', async t => {
  const SECRET = 'TEST_ONLY_HELD_SECRET', DOMAIN = 'admin.example.test';
  const { pool, queries } = fakePool([row(1, 'BUY', 'PRICE_UNAVAILABLE')]);
  const resolvers = stocksSessionResolvers(SECRET, [DOMAIN], [
    { wallet: a(90), operatorId: 'stocks-reader', permissions: ['stocks:read'] },
    { wallet: a(91), operatorId: 'stocks-controller', permissions: ['stocks:control'] },
  ]);
  const env: AppEnv = {
    corsAllowedOrigins: [`https://${DOMAIN}`], authNonceTtlSeconds: 60, authJwtSecret: SECRET, registryPath: '/NO_REGISTRY', adminOperatorToken: '',
    adminOperators: parseAdminOperators([{ wallet: a(92), operatorId: 'vault-full', permissions: ['vault:read', 'vault:write'] }]),
  };
  const service = { repo: { pool, deploymentDigest: DIGEST } };
  const app = buildApp(env, {
    arco: {}, registry: { listNetworks: async () => [] }, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) },
    stocks: { service, ...resolvers },
  } as unknown as ArcoAppServices);
  t.after(() => app.close());
  const { sign } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
  const headers = (wallet: string) => ({ authorization: `Bearer ${sign({ sub: wallet, domain: DOMAIN, chainId: 91342 }, SECRET, { expiresIn: '15m' })}` });

  for (const denied of [{}, headers(a(91)), headers(a(92)), headers(a(93))]) {
    const response = await app.inject({ url: '/api/v1/admin/stocks/held', headers: denied });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'OPERATOR_FORBIDDEN');
  }
  assert.equal(queries.length, 0);
  const invalid = await app.inject({ url: '/api/v1/admin/stocks/held?limit=500', headers: headers(a(90)) });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'INVALID_HELD_QUERY', ...PROFILE });
  assert.equal(queries.length, 0);
  const ok = await app.inject({ url: '/api/v1/admin/stocks/held?limit=10', headers: headers(a(90)) });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.equal(body.profile, PROFILE.profile);
  assert.equal(body.data.nextCursor, null);
  assert.equal(body.data.items[0].hold, 'PRICE_UNAVAILABLE');
  assert.deepEqual(queries[0].values, [DIGEST, null, null, null, 11]);
});
