import assert from 'node:assert/strict';
import test from 'node:test';
import { createStocksMarketDataService } from './service.js';
import { createSqlProfileStore, isProfileStoreKey, prismaProfileStoreSql, type ProfileStoreSql } from './profile-store.js';
import { stocksMarketProfileStoreEnabled } from '../stocks-market-runtime/config.js';
import type { DisplayCatalog } from './contracts.js';

const NOW = Date.parse('2026-09-27T02:00:00.000Z');
const SCOPE = 'a'.repeat(64);
const catalog = (...symbols: string[]): DisplayCatalog => ({ securities: symbols.map(symbol => ({ symbol, name: symbol })), provenance: { sourceUrl: null, rankingMetric: null, period: null, asOfDate: null, verification: 'CURATED' } });
const profile = (symbol: string, type = 'CS') => JSON.stringify({ status: 'OK', results: { ticker: symbol, locale: 'us', market: 'stocks', currency_name: 'usd', name: symbol, type, market_cap: 123456789, share_class_shares_outstanding: 42000000, branding: { icon_url: 'https://api.massive.com/v1/reference/company-branding/abc/images/icon.png' } } });
const snapshot = (time = NOW - 1000) => `{"status":"OK","tickers":[{"ticker":"NVDA","lastTrade":{"p":123.45,"t":${BigInt(time) * 1000000n}},"todaysChange":1,"todaysChangePerc":1,"day":{"v":10},"prevDay":{"c":122.45}}]}`;
const response = (body: string) => new Response(body, { headers: { 'Content-Type': 'application/json' } });

/** The table as the migration defines it, with the store's conditional upsert. */
function fakeDatabase() {
  const rows = new Map<string, { data: unknown; fetchedAt: string; sourceTimestamp: string | null }>();
  const statements: string[] = [];
  let failing = false;
  const sql: ProfileStoreSql = {
    async rows(text, values) {
      statements.push(text); if (failing) throw new Error('database down');
      assert.match(text, /^SELECT data, "fetchedAt"::text AS "fetchedAt", "sourceTimestamp"::text AS "sourceTimestamp" FROM arco_evm\."StocksMarketProfile" WHERE scope = \$1 AND "key" = \$2$/);
      const row = rows.get(`${values[0]}|${values[1]}`);
      return row ? [structuredClone(row)] : [];
    },
    async execute(text, values) {
      statements.push(text); if (failing) throw new Error('database down');
      assert.match(text, /^INSERT INTO arco_evm\."StocksMarketProfile" \(scope, "key", data, "fetchedAt", "sourceTimestamp"\) VALUES \(\$1, \$2, \$3::jsonb, \$4::bigint, \$5::bigint\)/);
      assert.match(text, /WHERE arco_evm\."StocksMarketProfile"\."fetchedAt" <= EXCLUDED\."fetchedAt"$/);
      const [scope, key, body, fetchedAt, sourceTimestamp] = values as [string, string, string, string, string | null];
      const id = `${scope}|${key}`; const prior = rows.get(id);
      if (!prior || BigInt(prior.fetchedAt) <= BigInt(fetchedAt)) rows.set(id, { data: JSON.parse(body), fetchedAt, sourceTimestamp });
      return 1;
    },
  };
  return { sql, rows, statements, fail: (value: boolean) => { failing = value; } };
}

test('company facts survive a restart through the database, without a provider call', async () => {
  const db = fakeDatabase(); let calls = 0;
  const first = createStocksMarketDataService({ apiKey: 'DO_NOT_PERSIST_SECRET', profileStore: createSqlProfileStore(db.sql), catalog: catalog('NVDA'), now: () => NOW, fetch: async () => { calls++; return response(profile('NVDA')); } });
  assert.equal((await first.profile('NVDA')).data?.marketCap, '123456789');
  assert.equal(calls, 1);
  assert.deepEqual([...db.rows.keys()].map(id => id.split('|')[1]), ['profile:NVDA']);
  assert.ok(!JSON.stringify([...db.rows.values()]).includes('DO_NOT_PERSIST_SECRET'), 'no provider key in the table');
  // A new server process: the profile is back at once and is not fetched again within its day.
  const restarted = createStocksMarketDataService({ apiKey: 'DO_NOT_PERSIST_SECRET', profileStore: createSqlProfileStore(db.sql), catalog: catalog('NVDA'), now: () => NOW + 60_000, fetch: async () => { calls++; throw new Error('should not refresh'); } });
  const restored = await restarted.profile('NVDA');
  assert.equal(restored.status, 'AVAILABLE');
  assert.equal(restored.data?.marketCap, '123456789');
  assert.equal(restored.data?.sharesOutstanding, '42000000');
  assert.equal(calls, 1);
});

test('after its day a stored profile is refreshed, and shown while the provider budget is spent', async () => {
  const db = fakeDatabase();
  await createStocksMarketDataService({ apiKey: 'fixture', profileStore: createSqlProfileStore(db.sql), catalog: catalog('NVDA'), now: () => NOW, fetch: async () => response(profile('NVDA')) }).profile('NVDA');
  const later = NOW + 2 * 86_400_000;
  const limited = createStocksMarketDataService({ apiKey: 'fixture', profileStore: createSqlProfileStore(db.sql), catalog: catalog('NVDA'), now: () => later, fetch: async () => new Response('{}', { status: 429 }) });
  const stale = await limited.profile('NVDA');
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.data?.marketCap, '123456789', 'the last known market cap, not a blank');
  const refreshed = createStocksMarketDataService({ apiKey: 'fixture', profileStore: createSqlProfileStore(db.sql), catalog: catalog('NVDA'), now: () => later, fetch: async () => response(profile('NVDA').replace('123456789', '223456789')) });
  assert.equal((await refreshed.profile('NVDA')).data?.marketCap, '223456789');
  const [row] = [...db.rows.values()];
  assert.equal(row?.fetchedAt, String(later), 'the refreshed fetch replaced the stored row');
});

test('quotes and charts never reach the store and keep their in-memory policy', async () => {
  const db = fakeDatabase(); let now = NOW, up = true;
  const s = createStocksMarketDataService({ apiKey: 'fixture', profileStore: createSqlProfileStore(db.sql), catalog: catalog('NVDA'), now: () => now, fetch: async () => { if (!up) throw new Error('down'); return response(snapshot(now - 1000)); } });
  assert.equal((await s.quotes()).data?.[0]?.price, '123.45');
  // Six minutes of provider failure: the quote expires exactly as without a store (no 7-day snapshot window).
  up = false; now += 6 * 60_000;
  assert.equal((await s.quotes()).data?.[0]?.price, null);
  assert.deepEqual(db.statements, [], 'no read or write for quotes');
  for (const key of ['quotes', 'chart:NVDA:1D', 'logo:NVDA', 'dividend:NVDA', 'profile:nvda', 'profile:NVDA:x']) assert.equal(isProfileStoreKey(key), false, key);
  for (const key of ['profile:NVDA', 'aum:SOXL', 'issuer:DRAM', 'profile:BRK.B']) assert.equal(isProfileStoreKey(key), true, key);
});

test('a database that is down never hides the provider answer', async () => {
  const db = fakeDatabase(); db.fail(true); let calls = 0;
  const s = createStocksMarketDataService({ apiKey: 'fixture', profileStore: createSqlProfileStore(db.sql), catalog: catalog('NVDA'), now: () => NOW, fetch: async () => { calls++; return response(profile('NVDA')); } });
  const result = await s.profile('NVDA');
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.data?.marketCap, '123456789');
  assert.equal(calls, 1);
});

test('the store: newer rows win, and malformed keys, scopes, times or rows are refused', async () => {
  const db = fakeDatabase(); const store = createSqlProfileStore(db.sql);
  await store.write(SCOPE, 'profile:NVDA', { data: { v: 2 }, fetchedAt: 2000, sourceTimestamp: null });
  await store.write(SCOPE, 'profile:NVDA', { data: { v: 1 }, fetchedAt: 1000, sourceTimestamp: 5 });
  assert.deepEqual(await store.read(SCOPE, 'profile:NVDA'), { data: { v: 2 }, fetchedAt: 2000, sourceTimestamp: null }, 'an older fetch finishing late does not replace a newer one');
  const before = db.statements.length;
  await store.write(SCOPE, 'quotes', { data: [], fetchedAt: 1, sourceTimestamp: null });
  await store.write('not-a-scope', 'profile:NVDA', { data: {}, fetchedAt: 1, sourceTimestamp: null });
  assert.equal(await store.read(SCOPE, 'chart:NVDA:1D'), null);
  assert.equal(db.statements.length, before, 'refused without touching the database');
  await assert.rejects(store.write(SCOPE, 'profile:NVDA', { data: {}, fetchedAt: -1, sourceTimestamp: null }), /INVALID_MARKET_PROFILE_SNAPSHOT/);
  await assert.rejects(store.write(SCOPE, 'profile:NVDA', { data: {}, fetchedAt: 1.5, sourceTimestamp: null }), /INVALID_MARKET_PROFILE_SNAPSHOT/);
  await assert.rejects(store.write(SCOPE, 'profile:NVDA', { data: { big: 'x'.repeat(1024 * 1024) }, fetchedAt: 1, sourceTimestamp: null }), /INVALID_MARKET_PROFILE_SNAPSHOT/);
  db.rows.set(`${SCOPE}|profile:MU`, { data: {}, fetchedAt: 'soon', sourceTimestamp: null });
  assert.equal(await store.read(SCOPE, 'profile:MU'), null, 'a malformed row is not a snapshot');
  db.rows.set(`${SCOPE}|profile:TSLA`, { data: '{"v":3}', fetchedAt: '3000', sourceTimestamp: '4' });
  assert.deepEqual(await store.read(SCOPE, 'profile:TSLA'), { data: { v: 3 }, fetchedAt: 3000, sourceTimestamp: 4 }, 'JSON handed back as text is parsed');
  db.rows.set(`${SCOPE}|profile:AMZN`, { data: '{not json', fetchedAt: '3000', sourceTimestamp: null });
  assert.equal(await store.read(SCOPE, 'profile:AMZN'), null);
});

test('STOCKS_MARKET_PROFILE_STORE is 1 (on), 0 or unset (off); Prisma receives bound values only', async () => {
  assert.equal(stocksMarketProfileStoreEnabled({}), false);
  assert.equal(stocksMarketProfileStoreEnabled({ STOCKS_MARKET_PROFILE_STORE: '0' }), false);
  assert.equal(stocksMarketProfileStoreEnabled({ STOCKS_MARKET_PROFILE_STORE: '1' }), true);
  for (const value of ['true', 'yes', ' 1', '']) assert.throws(() => stocksMarketProfileStoreEnabled({ STOCKS_MARKET_PROFILE_STORE: value }), /^Error: INVALID_MARKET_DATA_CONFIG$/);
  const calls: [string, string, unknown[]][] = [];
  const sql = prismaProfileStoreSql({
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]) { calls.push(['query', query, values]); return [] as T; },
    async $executeRawUnsafe(query: string, ...values: unknown[]) { calls.push(['execute', query, values]); return 1; },
  });
  const store = createSqlProfileStore(sql);
  assert.equal(await store.read(SCOPE, 'profile:NVDA'), null);
  await store.write(SCOPE, 'aum:SOXL', { data: { aum: '1' }, fetchedAt: 7, sourceTimestamp: 9 });
  assert.deepEqual(calls.map(([kind, , values]) => [kind, values]), [['query', [SCOPE, 'profile:NVDA']], ['execute', [SCOPE, 'aum:SOXL', '{"aum":"1"}', '7', '9']]]);
  assert.ok(calls.every(([, query]) => !query.includes(SCOPE) && !query.includes('SOXL')), 'values are never interpolated into the SQL');
});
