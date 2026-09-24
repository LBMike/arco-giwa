import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { performance } from 'node:perf_hooks';
import { createStocksMarketDataService, stocksMarketDataPlugin, type DisplayCatalog } from './index.js';
import { decimal, integer, parseExactJson } from './exact-json.js';
import { brandingPath, MassiveTransport } from './transport.js';
import { chart, chartPath, quotes } from './normalize.js';

// All observations below are synthetic; no provider credentials or live claims.
const TIME = Date.parse('2026-09-17T18:00:00.000Z');
const json = (text: string, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
const snapshot = (price = '123.456789012345678901', time = TIME - 1000) => `{"status":"OK","tickers":[{"ticker":"NVDA","lastTrade":{"p":${price},"t":${BigInt(time) * 1000000n}},"todaysChange":-0.000000000000000001,"todaysChangePerc":-1.5e-2,"day":{"v":9007199254740993},"prevDay":{"c":124}}]}`;
const overview = (icon = 'https://api.massive.com/v1/reference/company-branding/bnZkYQ/images/2026-09-17_icon.png') => JSON.stringify({ status: 'OK', results: { ticker: 'NVDA', market: 'stocks', locale: 'us', currency_name: 'usd', name: 'NVIDIA', description: 'Synthetic company description', branding: { icon_url: icon }, homepage_url: 'https://www.nvidia.com', type: 'CS' } });
const catalog = (symbols = ['NVDA', 'AAPL']): DisplayCatalog => ({ securities: symbols.map(symbol => ({ symbol, name: symbol })), provenance: { sourceUrl: null, rankingMetric: null, period: null, asOfDate: null, verification: 'CURATED' } });
const responseFetch = (body: string): typeof fetch => async () => json(body);

test('exact numeric tokens retain large integer, exponent and 18 fraction digits', () => {
  assert.equal(integer(parseExactJson('900719925474099312345')), 900719925474099312345n);
  assert.equal(decimal(parseExactJson('1.234567890123456789e2')), '123.4567890123456789');
  assert.equal(decimal(parseExactJson('-15e-3'), true), '-0.015');
  assert.equal(decimal(parseExactJson('-0.0')), '0');
  assert.equal(decimal(parseExactJson('1e-18')), '0.000000000000000001');
});
test('exact parser accepts escaped strings and isolates prototype names', () => {
  const parsed = parseExactJson('{"text":"a\\\"b\\\\c\\n\\u0041","__proto__":{"x":2}}') as Record<string, unknown>;
  assert.equal(parsed.text, 'a"b\\c\nA'); assert.equal(Object.getPrototypeOf(parsed), null);
});
test('malformed JSON and duplicate keys are rejected', () => {
  for (const value of ['', '01', '1.', '+1', '[1,]', '{"a":1,}', '{"a":1,"a":2}', 'NaN', 'true false', '"\\q"', '"\n"', '['.repeat(34) + ']'.repeat(34)]) assert.throws(() => parseExactJson(value), /INVALID_RESPONSE/);
});
test('numeric schema changes and unbounded precision/magnitude are rejected', () => {
  for (const value of ['"1"', '-1', '1e99999', '1e-19', '1e30']) assert.throws(() => decimal(parseExactJson(value)), /INVALID_RESPONSE/);
  assert.throws(() => integer(parseExactJson('0.1')), /INVALID_RESPONSE/);
});
test('missing key is explicit and makes no I/O; catalog remains available', async () => {
  let calls = 0; const s = createStocksMarketDataService({ fetch: async () => { calls++; throw new Error('must not execute'); } });
  assert.equal(s.catalog().data?.provenance.verification, 'PILOT');
  for (const response of [await s.quotes(), await s.profile('NVDA'), await s.chart('NVDA', '1D'), await s.logo('NVDA')]) { assert.equal(response.status, 'UNCONFIGURED'); assert.equal(response.reason, 'NOT_CONFIGURED'); assert.equal(response.feedDelay, 'UNKNOWN'); }
  assert.equal((await s.quotes()).data?.[0].price, null); assert.equal(calls, 0);
});
test('catalog validates bounds, duplicates, injection and verification provenance', () => {
  for (const c of [catalog([]), catalog(Array.from({ length: 41 }, (_, i) => `A${i}`)), catalog(['NVDA', 'NVDA']), catalog(['NVDA?apiKey=secret']), catalog(['../AAPL']), { ...catalog(), provenance: { ...catalog().provenance, verification: 'VERIFIED' as const } }]) assert.throws(() => createStocksMarketDataService({ catalog: c }), /INVALID_MARKET_DATA_CONFIG/);
  assert.equal(createStocksMarketDataService({ catalog: catalog() }).catalog().data?.provenance.verification, 'CURATED');
});
test('40 symbols use one explicitly filtered request; omitted symbols are unavailable', async () => {
  let calls = 0; let requested = ''; let auth = ''; let redirect = '';
  const c = catalog(['NVDA', ...Array.from({ length: 39 }, (_, i) => `S${i}`)]);
  const s = createStocksMarketDataService({ apiKey: 'fixture-key', catalog: c, now: () => TIME, fetch: async (url, init) => { calls++; requested = String(url); auth = String((init?.headers as Record<string, string>).Authorization); redirect = init?.redirect ?? ''; return json(snapshot()); } });
  const result = await s.quotes();
  assert.equal(calls, 1); const url = new URL(requested); assert.equal(url.pathname, '/v2/snapshot/locale/us/markets/stocks/tickers'); assert.equal(url.searchParams.get('tickers')?.split(',').length, 40); assert.equal(url.searchParams.get('apiKey'), null); assert.equal(auth, 'Bearer fixture-key'); assert.equal(redirect, 'error');
  assert.equal(result.data?.length, 40); assert.equal(result.data?.[0].price, '123.456789012345678901'); assert.equal(result.data?.[0].sessionVolume, '9007199254740993'); assert.equal(result.data?.[1].reason, 'MISSING_OBSERVATION'); assert.equal(result.executionPriceSource, 'FIXED_MOCK_PRICE');
  assert.ok(!JSON.stringify(result).includes('fixture-key'));
});
test('delayed snapshots work without lastTrade and use minute timestamp not updated', async () => {
  const raw = `{"status":"DELAYED","tickers":[{"ticker":"NVDA","min":{"c":100.25,"t":${TIME - 900000}},"updated":${BigInt(TIME) * 1000000n}}]}`;
  const result = await createStocksMarketDataService({ apiKey: 'x', feedDelay: 'DELAYED_15_MIN', now: () => TIME, fetch: responseFetch(raw) }).quotes();
  assert.equal(result.data?.[0].observationAgeMs, 900000); assert.equal(result.data?.[0].priceSource, 'MINUTE_CLOSE'); assert.equal(result.feedDelay, 'DELAYED_15_MIN');
});
test('empty reset objects never turn into zero/current prices', () => {
  for (const row of ['"day":{"c":10},"updated":1789668000000000000', '"min":{"c":0,"t":0}', '"lastTrade":{}']) {
    const result = quotes(parseExactJson(`{"status":"OK","tickers":[{"ticker":"NVDA",${row}}]}`), ['NVDA'], TIME);
    assert.equal(result[0].price, null); assert.equal(result[0].sourceTimestamp, null);
  }
});
test('mismatched, duplicate tickers and future timestamps fail closed', () => {
  for (const raw of [snapshot().replace('NVDA', 'AAPL'), snapshot('1', TIME + 61000), '{"status":"OK","tickers":[{"ticker":"NVDA"},{"ticker":"NVDA"}]}']) assert.throws(() => quotes(parseExactJson(raw), ['NVDA'], TIME), /INVALID_RESPONSE/);
});
test('singleflight serves a concurrent list storm with one call', async () => {
  let calls = 0; const s = createStocksMarketDataService({ apiKey: 'x', now: () => TIME, fetch: async () => { calls++; await new Promise(r => setTimeout(r, 15)); return json(snapshot()); } });
  const results = await Promise.all(Array.from({ length: 60 }, () => s.quotes()));
  assert.equal(calls, 1); assert.ok(results.every(r => r.status === 'AVAILABLE'));
  results[0].data![0].price = '999'; assert.notEqual((await s.quotes()).data![0].price, '999');
});
test('fetch age is separate from source age and old observations are explicit', async () => {
  let now = TIME; const s = createStocksMarketDataService({ apiKey: 'x', now: () => now, fetch: responseFetch(snapshot('100', TIME - 40 * 3600000)) });
  const a = await s.quotes(); now += 10000; const b = await s.quotes();
  assert.equal(a.status, 'STALE'); assert.equal(a.reason, 'OLD_OBSERVATION'); assert.equal(a.cacheAgeMs, 0); assert.equal(b.cacheAgeMs, 10000); assert.equal(b.data![0].observationAgeMs, 40 * 3600000 + 10000);
});
test('successful fetch does not make a one-hour-old trade fresh for real-time/delayed/unknown feeds', async () => {
  for (const feedDelay of ['REALTIME', 'DELAYED_15_MIN', 'UNKNOWN', 'END_OF_DAY'] as const) {
    const r = await createStocksMarketDataService({ apiKey: 'x', now: () => TIME, feedDelay, fetch: responseFetch(snapshot('100', TIME - 3600000)) }).quotes();
    assert.equal(r.cacheAgeMs, 0); assert.equal(r.data![0].observationAgeMs, 3600000);
    assert.equal(r.status, feedDelay === 'END_OF_DAY' ? 'AVAILABLE' : 'STALE');
  }
});
test('failed refresh retains bounded stale data, negative-caches, and finally expires', async () => {
  let now = TIME; let calls = 0; const s = createStocksMarketDataService({ apiKey: 'x', now: () => now, fetch: async () => { calls++; return calls === 1 ? json(snapshot()) : json('{"message":"secret upstream details"}', 503); } });
  await s.quotes(); now += 16000; const stale = await s.quotes();
  assert.equal(stale.status, 'STALE'); assert.equal(stale.reason, 'PROVIDER_UNAVAILABLE'); assert.equal(stale.fetchedAt, new Date(TIME).toISOString()); await s.quotes(); assert.equal(calls, 2);
  now = TIME + 300001; const expired = await s.quotes(); assert.equal(expired.status, 'UNAVAILABLE'); assert.equal(expired.data![0].price, null); assert.ok(!JSON.stringify(expired).includes('secret'));
});
test('out-of-order snapshot refresh is rejected and preserves prior observation', async () => {
  let now = TIME; let calls = 0; const s = createStocksMarketDataService({ apiKey: 'x', now: () => now, fetch: async () => json(snapshot('123', calls++ ? TIME - 10000 : TIME - 1000)) });
  await s.quotes(); now += 16000; const result = await s.quotes(); assert.equal(result.status, 'STALE'); assert.equal(result.reason, 'INVALID_RESPONSE'); assert.equal(result.data![0].sourceTimestamp, new Date(TIME - 1000).toISOString());
});
test('missing/reset snapshot does not erase the last accepted source high-water', async () => {
  let now = TIME; let calls = 0;
  const responses = [snapshot('123', TIME - 1000), '{"status":"OK","tickers":[]}', snapshot('122', TIME - 2000)];
  const s = createStocksMarketDataService({ apiKey: 'x', now: () => now, fetch: async () => json(responses[calls++]) });
  assert.equal((await s.quotes()).status, 'AVAILABLE'); now += 16000;
  assert.equal((await s.quotes()).data![0].price, null); now += 16000;
  const result = await s.quotes(); assert.equal(result.reason, 'INVALID_RESPONSE'); assert.equal(result.data![0].price, null); assert.notEqual(result.data![0].status, 'AVAILABLE');
});
test('per-symbol high-water survives partial omissions and failed batches advance no symbol', async () => {
  let now = TIME; let calls = 0;
  const row = (symbol: string, time: number) => `{"ticker":"${symbol}","lastTrade":{"p":123,"t":${BigInt(time) * 1000000n}}}`;
  const batch = (...rows: string[]) => `{"status":"OK","tickers":[${rows.join(',')}]}`;
  const responses = [batch(row('NVDA', TIME - 1000), row('AAPL', TIME - 1000)), batch(row('NVDA', TIME + 1000)), batch(row('NVDA', TIME + 2000), row('AAPL', TIME - 2000)), batch(row('NVDA', TIME + 1500), row('AAPL', TIME - 500))];
  const s = createStocksMarketDataService({ apiKey: 'x', catalog: catalog(), now: () => now, fetch: async () => json(responses[calls++]) });
  await s.quotes(); now += 16000; const partial = await s.quotes(); assert.equal(partial.data![1].price, null);
  now += 16000; const rejected = await s.quotes(); assert.equal(rejected.reason, 'INVALID_RESPONSE'); assert.equal(rejected.data![0].sourceTimestamp, new Date(TIME + 1000).toISOString());
  now += 31000; const accepted = await s.quotes(); assert.equal(accepted.status, 'AVAILABLE'); assert.equal(accepted.data![0].sourceTimestamp, new Date(TIME + 1500).toISOString()); assert.equal(accepted.data![1].sourceTimestamp, new Date(TIME - 500).toISOString());
});
test('429 cools down every provider key including profiles and charts', async () => {
  let calls = 0; let now = TIME; const s = createStocksMarketDataService({ apiKey: 'x', now: () => now, fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); } });
  assert.equal((await s.quotes()).reason, 'PROVIDER_RATE_LIMITED'); assert.equal((await s.profile('NVDA')).reason, 'PROVIDER_RATE_LIMITED'); assert.equal((await s.chart('NVDA', '1D')).reason, 'PROVIDER_RATE_LIMITED'); assert.equal(calls, 1);
  now += 60001; await s.quotes(); assert.equal(calls, 2);
});
test('global request budget cannot be bypassed with resource/range changes', async () => {
  let calls = 0; const s = createStocksMarketDataService({ apiKey: 'x', requestsPerMinute: 1, now: () => TIME, fetch: async () => { calls++; return json(snapshot()); } });
  await s.quotes(); assert.equal((await s.profile('NVDA')).reason, 'REQUEST_BUDGET_EXHAUSTED'); assert.equal((await s.chart('NVDA', '1D')).reason, 'REQUEST_BUDGET_EXHAUSTED'); assert.equal(calls, 1);
});
test('403 and malformed provider responses are sanitized with no fabricated data', async () => {
  for (const response of [json('{"apiKey":"super-secret"}', 403), json('{not JSON}'), json('{"status":"ERROR","error":"super-secret"}')]) {
    const s = createStocksMarketDataService({ apiKey: 'super-secret', fetch: async () => response }); const result = await s.quotes(); assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.data![0].price, null); assert.ok(!JSON.stringify(result).includes('super-secret'));
  }
});
test('profiles return nullable facts and only same-origin icon paths', async () => {
  const s = createStocksMarketDataService({ apiKey: 'x', fetch: responseFetch(overview()) }); const result = await s.profile('NVDA');
  assert.equal(result.data!.logoUrl, '/api/v1/stocks/market/NVDA/logo'); assert.equal(result.data!.marketCap, null); assert.equal(result.data!.sourceDate, null); assert.equal(result.data!.industry, null);
});
test('profile ticker, market, locale and currency must match', async () => {
  for (const raw of [overview().replace('"NVDA"', '"AAPL"'), overview().replace('"stocks"', '"crypto"'), overview().replace('"usd"', '"eur"'), overview().replace('"us"', '"global"')]) assert.equal((await createStocksMarketDataService({ apiKey: 'x', fetch: responseFetch(raw) }).profile('NVDA')).reason, 'INVALID_RESPONSE');
});
test('logo allowlist rejects SVG, credentials, queries, SSRF, encoded paths and lookalikes', async () => {
  for (const value of ['https://evil.example/icon.png', 'https://api.massive.com.evil.example/v1/reference/company-branding/a/images/b.png', 'https://key@api.massive.com/v1/reference/company-branding/a/images/b.png', 'https://api.massive.com/v1/reference/company-branding/a/images/b.png?apiKey=x', 'http://api.massive.com/v1/reference/company-branding/a/images/b.png', 'https://api.massive.com/v1/reference/company-branding/a/images/b.svg', 'https://api.massive.com/v1/reference/company-branding/a/images/%2e%2e/b.png']) {
    assert.equal(brandingPath(value), null); const p = await createStocksMarketDataService({ apiKey: 'x', fetch: responseFetch(overview(value)) }).profile('NVDA'); assert.equal(p.data!.logoUrl, null);
  }
});
test('chart uses fixed ranges, 50000 base aggregate limit, and exact OHLCV', () => {
  assert.match(chartPath('NVDA', '1W', TIME), /range\/1\/hour\/\d+\/\d+\?adjusted=true&sort=asc&limit=50000$/);
  const raw = `{"status":"OK","ticker":"NVDA","adjusted":true,"queryCount":1,"resultsCount":1,"results":[{"t":${TIME - 100000},"o":100.123456789012345678,"h":101,"l":99,"c":100.5,"v":9007199254740993}]}`;
  const result = chart(parseExactJson(raw), 'NVDA', '1D', TIME); assert.equal(result.bars[0].open, '100.123456789012345678'); assert.equal(result.bars[0].volume, '9007199254740993'); assert.equal(result.complete, true); assert.equal(result.history, 'RETURNED_WINDOW');
});
test('holiday/no-trade chart is empty rather than zero, and partial pagination is explicit', () => {
  const base = '{"status":"OK","ticker":"NVDA","adjusted":true,"resultsCount":0';
  assert.equal(chart(parseExactJson(base + '}'), 'NVDA', '1D', TIME).history, 'EMPTY');
  for (const extra of [',"next_url":"https://evil.example/?apiKey=secret"', ',"queryCount":50000']) { const result = chart(parseExactJson(base + extra + '}'), 'NVDA', '1D', TIME); assert.equal(result.complete, false); assert.equal(result.history, 'TRUNCATED'); assert.ok(!JSON.stringify(result).includes('evil')); }
});
test('impossible OHLC, out-of-order/duplicate/future/out-of-window bars fail closed', () => {
  const bar = (t: number, o = '100') => `{"t":${t},"o":${o},"h":101,"l":99,"c":100,"v":2}`;
  for (const bars of [bar(TIME - 1000, '102'), `${bar(TIME - 1000)},${bar(TIME - 2000)}`, `${bar(TIME - 1000)},${bar(TIME - 1000)}`, bar(TIME + 1000), bar(TIME - 2 * 86400000)]) assert.throws(() => chart(parseExactJson(`{"status":"OK","ticker":"NVDA","adjusted":true,"results":[${bars}]}`), 'NVDA', '1D', TIME), /INVALID_RESPONSE/);
  assert.throws(() => chart(parseExactJson('{"status":"OK","ticker":"NVDA","adjusted":false}'), 'NVDA', '1D', TIME), /INVALID_RESPONSE/);
});
test('fixed ranges reject impossible aggregate density before retaining chart data', () => {
  const bar = (t: number) => `{"t":${t},"o":100,"h":101,"l":99,"c":100,"v":2}`;
  for (const bars of [`${bar(TIME - 2000)},${bar(TIME - 1000)}`, Array.from({ length: 291 }, (_, i) => bar(TIME - 291000 + i * 1000)).join(',')]) assert.throws(() => chart(parseExactJson(`{"status":"OK","ticker":"NVDA","adjusted":true,"results":[${bars}]}`), 'NVDA', '1D', TIME), /INVALID_RESPONSE/);
});
test('ignored abort and stalled body both obey the total deadline', async () => {
  for (const fetcher of [async () => { await new Promise(r => setTimeout(r, 80)); return json(snapshot()); }, async () => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } })]) {
    const transport = new MassiveTransport({ apiKey: 'x', timeoutMs: 15, fetch: fetcher }); const start = performance.now();
    await assert.rejects(transport.json('/v3/reference/tickers/NVDA'), /TIMEOUT/); assert.ok(performance.now() - start < 70);
  }
});
test('an event-loop-stalled late success is discarded before publication', async () => {
  const s = createStocksMarketDataService({ apiKey: 'x', timeoutMs: 10, fetch: async () => { const until = performance.now() + 25; while (performance.now() < until) { /* emulate blocked transport */ } return json(snapshot()); } });
  assert.equal((await s.quotes()).reason, 'TIMEOUT');
});
test('declared and streamed oversized responses are rejected', async () => {
  for (const response of [new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '3000000' } }), new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })]) await assert.rejects(new MassiveTransport({ apiKey: 'x', fetch: async () => response }).json('/v3/reference/tickers/NVDA'), /RESPONSE_TOO_LARGE/);
});
test('network failures and redirect responses cannot leak URLs or bodies', async () => {
  for (const fetcher of [async () => { throw new Error('https://secret.example?apiKey=SECRET'); }, async () => new Response('SECRET', { status: 302, headers: { location: 'https://evil.example' } })]) {
    const r = await createStocksMarketDataService({ apiKey: 'x', fetch: fetcher }).quotes(); assert.equal(r.status, 'UNAVAILABLE'); assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
});
test('logo proxy validates MIME and signature and caches raster bytes', async () => {
  let calls = 0; const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const s = createStocksMarketDataService({ apiKey: 'x', fetch: async url => { calls++; return String(url).includes('company-branding') ? new Response(png, { headers: { 'Content-Type': 'image/png' } }) : json(overview()); } });
  assert.equal((await s.logo('NVDA')).data!.contentType, 'image/png'); await s.logo('NVDA'); assert.equal(calls, 2);
  for (const response of [new Response('<svg/>', { headers: { 'Content-Type': 'image/png' } }), new Response(png, { headers: { 'Content-Type': 'image/svg+xml' } })]) await assert.rejects(new MassiveTransport({ apiKey: 'x', fetch: async () => response }).logo('/v1/reference/company-branding/a/images/b.png'), /INVALID_RESPONSE/);
});
test('optional plugin validates route/query boundaries and never accepts arbitrary symbols', async () => {
  const app = Fastify(); await app.register(stocksMarketDataPlugin, { service: createStocksMarketDataService() });
  try {
    for (const url of ['/api/v1/stocks/market/quotes?tickers=AAPL', '/api/v1/stocks/market/catalog?all=true', '/api/v1/stocks/market/NVDA/chart?range=ALL', '/api/v1/stocks/market/NVDA/chart?range=1D&range=1Y', '/api/v1/stocks/market/NVDA/chart?range=1D&from=0']) assert.equal((await app.inject(url)).statusCode, 400);
    assert.equal((await app.inject('/api/v1/stocks/market/AAPL/profile')).statusCode, 404);
    const r = await app.inject('/api/v1/stocks/market/NVDA/chart?range=1D'); assert.equal(r.statusCode, 200); assert.equal(r.json().status, 'UNCONFIGURED'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
    const logo = await app.inject('/api/v1/stocks/market/NVDA/logo'); assert.equal(logo.statusCode, 404); assert.equal(logo.json().purpose, 'DISPLAY_ONLY');
  } finally { await app.close(); }
});

test('ETF profiles read exact AUM from ETF Global, keep market cap separate, and cache the result', async () => {
  const calls: string[] = [];
  const service = createStocksMarketDataService({ apiKey: 'fixture', now: () => TIME, catalog: catalog(['SOXL']), fetch: async url => {
    const path = new URL(String(url)); calls.push(path.pathname);
    if (path.pathname.endsWith('/SOXL')) return json(JSON.stringify({ status: 'OK', results: { ticker: 'SOXL', locale: 'us', market: 'stocks', currency_name: 'usd', name: 'SOXL', type: 'ETF', market_cap: 999 } }));
    assert.equal(path.searchParams.get('composite_ticker'), 'SOXL');
    assert.equal(path.searchParams.get('sort'), 'effective_date.desc');
    return json('{"status":"OK","results":[{"composite_ticker":"SOXL","product_type":"etf","aum":12345678901.123456789,"effective_date":"2026-09-16"}]}');
  } });
  const response = await service.profile('SOXL');
  assert.equal(response.data?.aum, '12345678901.123456789');
  assert.equal(response.data?.marketCap, '999');
  assert.equal(response.data?.aumAsOf, '2026-09-16');
  await service.profile('SOXL');
  assert.equal(calls.length, 2);
});
test('ETF AUM permission failure preserves ticker profile without relabeling market cap as AUM', async () => {
  const service = createStocksMarketDataService({ apiKey: 'fixture', now: () => TIME, catalog: catalog(['SOXL']), fetch: async url => String(url).includes('/etf-global/') ? json('{}', 403) : json(JSON.stringify({ status: 'OK', results: { ticker: 'SOXL', locale: 'us', market: 'stocks', currency_name: 'usd', name: 'SOXL', type: 'ETF', market_cap: 999 } })) });
  const response = await service.profile('SOXL');
  assert.equal(response.status, 'AVAILABLE');
  assert.equal(response.data?.aum, null);
  assert.equal(response.data?.marketCap, '999');
});

test('ETF AUM budget exhaustion stays retryable while preserving the base profile', async () => {
  let now = TIME;
  let calls = 0;
  const service = createStocksMarketDataService({ apiKey: 'fixture', requestsPerMinute: 1, now: () => now, catalog: catalog(['SOXL']), fetch: async url => {
    calls++;
    return String(url).includes('/etf-global/')
      ? json('{"status":"OK","results":[{"composite_ticker":"SOXL","product_type":"etf","aum":12000000,"effective_date":"2026-09-16"}]}')
      : json(JSON.stringify({ status: 'OK', results: { ticker: 'SOXL', locale: 'us', market: 'stocks', currency_name: 'usd', name: 'SOXL', type: 'ETF', market_cap: 999 } }));
  } });
  const limited = await service.profile('SOXL');
  assert.equal(limited.status, 'AVAILABLE');
  assert.equal(limited.reason, 'REQUEST_BUDGET_EXHAUSTED');
  assert.equal(limited.data?.aum, null);
  assert.equal(limited.data?.marketCap, '999');
  assert.equal(calls, 1);
  now += 60001;
  const recovered = await service.profile('SOXL');
  assert.equal(recovered.reason, null);
  assert.equal(recovered.data?.aum, '12000000');
  assert.equal(calls, 2);
});
