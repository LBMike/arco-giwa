import assert from 'node:assert/strict';
import test from 'node:test';
import { createStocksMarketDataService } from './service.js';
import { AlpacaTransport } from './transport.js';
import { configuredStocksMarketData } from '../stocks-market-runtime/config.js';

const NOW = Date.parse('2026-09-21T18:00:00.000Z');
const credentials = { provider: 'ALPACA' as const, alpacaKeyId: 'TEST_ONLY_ID', alpacaSecretKey: 'TEST_ONLY_SECRET' };
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
const snap = (price = '123.456789012345678901', time = '2026-09-21T17:59:59.123456789Z', volumeTime = '2026-09-21T04:00:00Z') => `{"NVDA":{"latestTrade":{"p":${price},"t":"${time}"},"minuteBar":{"c":120,"t":"2026-09-21T17:59:00Z"},"dailyBar":{"v":9007199254740993,"t":"${volumeTime}"},"prevDailyBar":{"c":100,"t":"2026-09-18T04:00:00Z"}}}`;

test('Alpaca batch quotes use fixed host/header auth, retain exact decimals, compute changes and singleflight', async () => {
  let calls = 0;
  const service = createStocksMarketDataService({ ...credentials, now: () => NOW, fetch: async (input, init) => {
    calls++;
    const url = new URL(String(input)); const headers = new Headers(init?.headers);
    assert.equal(url.origin, 'https://data.alpaca.markets'); assert.equal(url.pathname, '/v2/stocks/snapshots');
    assert.equal(url.searchParams.get('symbols'), 'NVDA'); assert.equal(url.searchParams.get('feed'), 'iex');
    assert.equal(headers.get('APCA-API-KEY-ID'), credentials.alpacaKeyId);
    assert.equal(headers.get('APCA-API-SECRET-KEY'), credentials.alpacaSecretKey);
    assert.equal(headers.get('authorization'), null); assert.equal(init?.redirect, 'error');
    assert.ok(!url.href.includes(credentials.alpacaSecretKey)); return response(snap());
  } });
  const batches = await Promise.all(Array.from({ length: 8 }, () => service.quotes()));
  assert.equal(calls, 1);
  for (const batch of batches) {
    assert.equal(batch.provider, 'ALPACA'); assert.equal(batch.marketFeed, 'IEX');
    assert.equal(batch.data![0].price, '123.456789012345678901');
    assert.equal(batch.data![0].sessionVolume, '9007199254740993');
    assert.equal(batch.data![0].change, '23.456789012345678901');
    assert.equal(batch.data![0].changePercent, '23.456789012345678901');
    assert.equal(batch.data![0].sourceTimestamp, '2026-09-21T17:59:59.123Z');
    assert.ok(!JSON.stringify(batch).includes(credentials.alpacaSecretKey));
  }
  await service.quotes(); assert.equal(calls, 1);
});

test('snapshot chooses newest observation; unrelated daily volume is absent', async () => {
  const service = createStocksMarketDataService({ ...credentials, now: () => NOW, fetch: async () => response(snap('124', '2026-09-21T17:58:00Z', '2026-09-18T04:00:00Z')) });
  const q = (await service.quotes()).data![0];
  assert.equal(q.price, '120'); assert.equal(q.priceSource, 'MINUTE_CLOSE'); assert.equal(q.sessionVolume, null);
});

test('missing observations remain unavailable; stale timestamps are not refreshed by fresh fetches', async () => {
  const missing = createStocksMarketDataService({ ...credentials, now: () => NOW, fetch: async () => response('{}') });
  assert.equal((await missing.quotes()).data![0].reason, 'MISSING_OBSERVATION');
  const stale = createStocksMarketDataService({ ...credentials, now: () => NOW, fetch: async () => response('{"NVDA":{"latestTrade":{"p":100,"t":"2026-09-18T20:00:00Z"}}}') });
  assert.equal((await stale.quotes()).reason, 'OLD_OBSERVATION');
});

test('Alpaca source timestamp rollback retains previous cache as stale', async () => {
  let now = NOW; let calls = 0;
  const service = createStocksMarketDataService({ ...credentials, now: () => now, fetch: async () => response(++calls === 1 ? snap() : snap('140', '2026-09-21T17:59:30Z')) });
  await service.quotes(); now += 16000;
  const next = await service.quotes(); assert.equal(next.status, 'STALE'); assert.equal(next.reason, 'INVALID_RESPONSE'); assert.equal(next.data![0].price, '123.456789012345678901');
});

test('Alpaca unconfigured credentials make zero calls; profile enrichment is independent', async () => {
  let calls = 0;
  const service = createStocksMarketDataService({ provider: 'ALPACA', alpacaKeyId: 'ONLY_ID', fetch: async () => { calls++; throw new Error('NO_NETWORK'); } });
  assert.equal((await service.quotes()).status, 'UNCONFIGURED'); assert.equal((await service.chart('NVDA', '1D')).status, 'UNCONFIGURED');
  const profile = await service.profile('NVDA'); assert.equal(profile.status, 'UNCONFIGURED'); assert.equal(profile.provider, 'MASSIVE'); assert.equal(profile.marketFeed, undefined); assert.equal(calls, 0);
});

test('Alpaca prices and Massive profiles use separate credentials and truthful provenance', async () => {
  const service = createStocksMarketDataService({ ...credentials, apiKey: 'TEST_MASSIVE', now: () => NOW, fetch: async (input, init) => {
    const url = new URL(String(input)); const headers = new Headers(init?.headers);
    if (url.hostname === 'data.alpaca.markets') { assert.equal(headers.get('authorization'), null); return response(snap()); }
    assert.equal(url.origin, 'https://api.massive.com'); assert.equal(headers.get('authorization'), 'Bearer TEST_MASSIVE'); assert.equal(headers.get('APCA-API-SECRET-KEY'), null);
    return response('{"status":"OK","results":{"ticker":"NVDA","name":"NVIDIA","locale":"us","market":"stocks","currency_name":"usd","type":"CS","market_cap":9007199254740993}}');
  } });
  assert.equal((await service.quotes()).provider, 'ALPACA');
  const profile = await service.profile('NVDA'); assert.equal(profile.provider, 'MASSIVE'); assert.equal(profile.marketFeed, undefined); assert.equal(profile.data!.marketCap, '9007199254740993');
});

test('Alpaca chart supplies split adjustment/feed and marks pagination truncated without following token', async () => {
  let calls = 0;
  const service = createStocksMarketDataService({ ...credentials, alpacaFeed: 'sip', now: () => NOW, fetch: async (input) => {
    calls++; const url = new URL(String(input)); assert.equal(url.pathname, '/v2/stocks/NVDA/bars');
    assert.equal(url.searchParams.get('feed'), 'sip'); assert.equal(url.searchParams.get('adjustment'), 'split'); assert.equal(url.searchParams.get('timeframe'), '5Min');
    assert.equal(url.searchParams.get('limit'), '10000'); assert.equal(url.searchParams.get('start'), '2026-09-20T18:00:00.000Z');
    return response('{"symbol":"NVDA","bars":[{"t":"2026-09-21T17:55:00Z","o":123,"h":125,"l":122,"c":124,"v":9007199254740993}],"next_page_token":"OPAQUE"}');
  } });
  const chart = await service.chart('NVDA', '1D'); assert.equal(chart.marketFeed, 'SIP'); assert.equal(chart.data!.history, 'TRUNCATED'); assert.equal(chart.data!.complete, false); assert.equal(chart.data!.bars[0].volume, '9007199254740993');
  await service.chart('NVDA', '1D'); assert.equal(calls, 1);
});

test('Alpaca rejects invalid timestamps, schema, decimals, unsolicited symbols, duplicate keys, and chart OHLC', async () => {
  for (const body of [snap('"120"'), snap('120', '2026-09-22T18:00:00Z'), '{"AAPL":{}}', '{"NVDA":{},"NVDA":{}}', '{"NVDA":{"latestTrade":{"p":1,"t":"2026-02-30T18:00:00Z"}}}']) {
    const service = createStocksMarketDataService({ ...credentials, now: () => NOW, fetch: async () => response(body) });
    assert.equal((await service.quotes()).reason, 'INVALID_RESPONSE');
  }
  const service = createStocksMarketDataService({ ...credentials, now: () => NOW, fetch: async () => response('{"symbol":"NVDA","bars":[{"t":"2026-09-21T17:55:00Z","o":130,"h":125,"l":122,"c":124,"v":1}]}') });
  assert.equal((await service.chart('NVDA', '1D')).reason, 'INVALID_RESPONSE');
});

test('Alpaca denial, timeout, byte limits and rate budget retain sanitized reasons', async () => {
  for (const [fetcher, expected] of [
    [async () => response('{"message":"TEST_ONLY_SECRET"}', 403), 'PROVIDER_UNAUTHORIZED'],
    [async () => response('{}', 429), 'PROVIDER_RATE_LIMITED'],
    [async () => { throw new Error(credentials.alpacaSecretKey); }, 'PROVIDER_UNAVAILABLE'],
    [async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2097153' } }), 'RESPONSE_TOO_LARGE'],
    [async () => new Promise<Response>(() => {}), 'TIMEOUT'],
  ] as const) {
    const service = createStocksMarketDataService({ ...credentials, timeoutMs: 10, fetch: fetcher });
    const result = await service.quotes(); assert.equal(result.reason, expected); assert.ok(!JSON.stringify(result).includes(credentials.alpacaSecretKey));
  }
  const transport = new AlpacaTransport({ keyId: 'ID', secretKey: 'SECRET', requestsPerMinute: 1, fetch: async () => response('{}') });
  await transport.json('/v2/stocks/snapshots'); await assert.rejects(transport.json('/v2/stocks/snapshots'), /REQUEST_BUDGET_EXHAUSTED/);
  for (const path of ['https://evil.test/', '//evil.test/', '/v2/stocks?apiKey=secret']) await assert.rejects(transport.json(path), /INVALID_RESPONSE/);
});

test('runtime provider/catalog/feed selection is explicit, default-compatible, and validates without echo', async () => {
  const defaults = configuredStocksMarketData({}); assert.equal(defaults.catalog().provider, 'MASSIVE'); assert.equal(defaults.catalog().data!.securities.length, 1);
  let calls = 0;
  const service = configuredStocksMarketData({ STOCKS_MARKET_DATA_PROVIDER: 'ALPACA', STOCKS_MARKET_DATA_CATALOG: 'CURATED_40', ALPACA_API_KEY_ID: 'ID', ALPACA_API_SECRET_KEY: 'SECRET', ALPACA_DATA_FEED: 'sip' }, { now: () => NOW, fetch: async input => { calls++; const url = new URL(String(input)); assert.equal(url.searchParams.get('symbols')!.split(',').length, 40); return response('{}'); } });
  assert.equal(service.catalog().data!.provenance.verification, 'CURATED'); assert.equal(service.catalog().data!.securities.length, 40); assert.equal((await service.quotes()).marketFeed, 'SIP'); assert.equal(calls, 1);
  for (const settings of [{ STOCKS_MARKET_DATA_PROVIDER: 'BAD_PRIVATE_VALUE' }, { ALPACA_DATA_FEED: 'BAD_PRIVATE_VALUE' }, { STOCKS_MARKET_DATA_CATALOG: 'BAD_PRIVATE_VALUE' }, { STOCKS_MARKET_DATA_PROVIDER: 'ALPACA', ALPACA_API_KEY_ID: 'ID\n', ALPACA_API_SECRET_KEY: 'secret' }]) assert.throws(() => configuredStocksMarketData(settings), /^Error: INVALID_MARKET_DATA_CONFIG$/);
});

test('derived percent overflow preserves price and omits unrepresentable percentage', async () => {
  const service = createStocksMarketDataService({ ...credentials, now: () => NOW, fetch: async () => response('{"NVDA":{"latestTrade":{"p":999999999999999999999999999999,"t":"2026-09-21T17:59:59Z"},"prevDailyBar":{"c":0.000000000000000001,"t":"2026-09-18T04:00:00Z"}}}') });
  const q = (await service.quotes()).data![0]; assert.equal(q.price, '999999999999999999999999999999'); assert.equal(q.changePercent, null); assert.equal(q.status, 'AVAILABLE');
});

test('premarket compares against freshest previous session daily bar, not two-session-old prevDailyBar', async () => {
  const service = createStocksMarketDataService({ ...credentials, now: () => NOW, fetch: async () => response('{"NVDA":{"latestTrade":{"p":110,"t":"2026-09-21T12:00:00Z"},"dailyBar":{"c":100,"v":400,"t":"2026-09-18T04:00:00Z"},"prevDailyBar":{"c":90,"t":"2026-09-17T04:00:00Z"}}}') });
  const q = (await service.quotes()).data![0]; assert.equal(q.previousClose, '100'); assert.equal(q.changePercent, '10'); assert.equal(q.sessionVolume, null);
});
