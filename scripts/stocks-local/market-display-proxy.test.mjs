import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketDisplayProxy } from './market-display-proxy.mjs';

const ORIGIN = 'http://127.0.0.1:4392';
const ROOT = `${ORIGIN}/api/v1/stocks/market`;
const context = { schemaVersion: 1, profile: 'DEMO_TESTNET', chainId: 91342,
  purpose: 'DISPLAY_ONLY', priceBasis: 'UNDERLYING_SECURITY', executionPriceSource: 'FIXED_MOCK_PRICE' };
const symbols = 'SOXL MU TSLA SNDK GOOGL SOXS SGOV SPCX SCHD NVDA VOO KORU AVGO IONQ MSTR META TQQQ QQQM AMZN IREN QLD SKHY MRK MRVL QQQ SMR JEPQ LITE BE DRAM NBIS PLTR SOXX INTC RAM ORCL MRNA CRCL BMNR RKLB'.split(' ');
const catalog = { securities: symbols.map((symbol, index) => ({ symbol, name: symbol === 'NVDA' ? 'NVIDIA' : symbol, rank: index + 1 })),
  provenance: { sourceUrl: null, rankingMetric: null, period: null, asOfDate: null, verification: 'CURATED' } };
const wrap = (data, patch = {}) => ({ ...context, provider: 'ALPACA', marketFeed: 'IEX',
  status: 'AVAILABLE', reason: null, data, fetchedAt: '2026-09-24T12:00:00.000Z',
  cacheAgeMs: 0, feedDelay: 'REALTIME', ...patch });
const response = value => Response.json(value);
const quote = { symbol: 'NVDA', currency: 'USD', price: '124.5', change: '1.5', changePercent: '1.22',
  sessionVolume: '12000', previousClose: '123', sourceTimestamp: '2026-09-24T11:59:00.000Z',
  observationAgeMs: 60000, priceSource: 'LAST_TRADE', status: 'AVAILABLE', reason: null };
const quotes = symbols.map(symbol => ({ ...quote, symbol }));
const profile = { symbol: 'NVDA', name: 'NVIDIA', description: null, exchange: 'NASDAQ',
  securityType: 'CS', currency: 'USD', marketCap: '1000000000', sharesOutstanding: null,
  aum: null, aumAsOf: null, issuerFundamentals: null, website: null, industry: null,
  logoUrl: '/api/v1/stocks/market/NVDA/logo', sourceDate: null };
const chart = { symbol: 'NVDA', currency: 'USD', range: '1D', interval: '5m', adjustedForSplits: true,
  from: '2026-09-23T12:00:00.000Z', to: '2026-09-24T12:00:00.000Z', bars: [],
  history: 'EMPTY', complete: true };

test('explicit loopback origin and budgets are required before any request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return response(wrap(catalog)); };
  for (const origin of [undefined, 'http://localhost:4392', 'http://127.0.0.1',
    'https://127.0.0.1:4392', 'http://127.0.0.1:4392/path',
    'http://127.0.0.1:4392/?token=x', 'http://u:p@127.0.0.1:4392',
    'http://127.0.0.1:80', 'http://127.0.0.1:65536'])
    await assert.rejects(() => createMarketDisplayProxy({ origin, fetcher }), /EXPLICIT_LOOPBACK_MARKET_ORIGIN_REQUIRED/);
  await assert.rejects(() => createMarketDisplayProxy({ origin: ORIGIN, fetcher, timeoutMs: 0 }), /INVALID_LOCAL_MARKET_BUDGET/);
  assert.equal(calls, 0);
});

test('allowlisted public display GETs use no credentials and preserve separate mock execution context', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === `${ROOT}/catalog`) return response(wrap(catalog));
    if (url === `${ROOT}/quotes`) return response(wrap(quotes));
    if (url === `${ROOT}/NVDA/profile`) return response(wrap(profile, { provider: 'MASSIVE', marketFeed: undefined }));
    if (url === `${ROOT}/NVDA/chart?range=1D`) return response(wrap(chart));
    throw Error('route escaped allowlist');
  };
  const service = await createMarketDisplayProxy({ origin: ORIGIN, fetcher });
  assert.equal(service.catalog().data.securities.length, 40);
  assert.equal(service.catalog().data.securities[9].symbol, 'NVDA');
  service.catalog().data.securities[9].name = 'MUTATED';
  assert.equal(service.catalog().data.securities[9].name, 'NVIDIA');
  assert.equal(service.hasSymbol('NVDA'), true);
  assert.equal(service.hasSymbol('AAPL'), false);
  assert.equal((await service.quotes()).data[9].price, '124.5');
  const p = await service.profile('NVDA');
  assert.equal(p.status, 'AVAILABLE');
  assert.equal(p.provider, 'MASSIVE');
  assert.equal(p.data.logoUrl, null);
  assert.equal((await service.chart('NVDA', '1D')).data.history, 'EMPTY');
  assert.equal((await service.logo('NVDA')).status, 'UNAVAILABLE');
  assert.equal(calls.length, 4);
  for (const { url, init } of calls) {
    assert.ok(url.startsWith(`${ROOT}/`));
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal(new Headers(init.headers).get('authorization'), null);
  }
  assert.throws(() => service.profile('../orders'), /UNKNOWN_MARKET_SYMBOL/);
  assert.throws(() => service.chart('NVDA', '1D&admin=true'), /INVALID_MARKET_RANGE/);
  assert.equal(calls.length, 4);
});

test('startup rejects unavailable or forged catalog; no synthetic 40-stock fallback', async () => {
  for (const result of [
    async () => { throw Error('private upstream detail'); },
    async () => response(wrap(catalog, { purpose: 'TRADING' })),
    async () => response(wrap({ ...catalog, securities: [{ symbol: '../orders', name: 'bad' }] })),
    async () => response(wrap(catalog, { status: 'UNAVAILABLE', data: null })),
    async () => response(wrap({ ...catalog, securities: [{ symbol: 'NVDA', name: 'NVIDIA' }], provenance: { ...catalog.provenance, verification: 'PILOT' } }, { provider: 'MASSIVE', marketFeed: undefined, feedDelay: 'UNKNOWN' })),
    async () => response(wrap(catalog, { provider: 'MASSIVE', marketFeed: undefined })),
    async () => response(wrap(catalog, { marketFeed: 'SIP' })),
    async () => response(wrap(catalog, { feedDelay: 'UNKNOWN' })),
    async () => response(wrap({ ...catalog, securities: catalog.securities.map((item, index) => index === 0 ? { ...item, symbol: 'AAPL' } : item) })),
  ]) await assert.rejects(() => createMarketDisplayProxy({ origin: ORIGIN, fetcher: result }), /^Error: LOCAL_MARKET_UNAVAILABLE$/);
});

test('outage and malformed market responses fail closed, then the same service recovers', async () => {
  let next = response(wrap(quotes));
  const service = await createMarketDisplayProxy({ origin: ORIGIN, fetcher: async url =>
    url.endsWith('/catalog') ? response(wrap(catalog)) : next });
  next = Promise.reject(Error('private token from upstream'));
  const down = await service.quotes();
  assert.equal(down.status, 'UNAVAILABLE');
  assert.equal(down.data, null);
  assert.equal(JSON.stringify(down).includes('private token'), false);
  next = response(wrap([quote], { executionPriceSource: 'LIVE_PRICE' }));
  assert.equal((await service.quotes()).status, 'UNAVAILABLE');
  next = response(wrap(quotes.map((item, index) => index === 0 ? { ...item, symbol: 'AAPL' } : item)));
  assert.equal((await service.quotes()).status, 'UNAVAILABLE');
  next = response(wrap(quotes.map((item, index) => index === 0 ? { ...item, sourceTimestamp: '2026-09-24T12:02:00.000Z' } : item)));
  assert.equal((await service.quotes()).status, 'UNAVAILABLE');
  next = response(wrap(quotes));
  assert.equal((await service.quotes()).data[9].price, '124.5');
  next = response(wrap({ ...chart, range: '1Y' }));
  assert.equal((await service.chart('NVDA', '1D')).status, 'UNAVAILABLE');
  next = response(wrap({ ...profile, symbol: 'AAPL' }, { provider: 'MASSIVE', marketFeed: undefined }));
  assert.equal((await service.profile('NVDA')).status, 'UNAVAILABLE');
});

test('redirects, oversized bodies and stalled reads cannot expose upstream data', async () => {
  let result;
  const service = await createMarketDisplayProxy({ origin: ORIGIN, timeoutMs: 30, maxBytes: 5000,
    fetcher: async url => url.endsWith('/catalog') ? response(wrap(catalog)) : result });
  result = Response.redirect('https://foreign.example/private');
  assert.equal((await service.quotes()).status, 'UNAVAILABLE');
  result = new Response('x'.repeat(5001), { headers: { 'content-type': 'application/json' } });
  assert.equal((await service.quotes()).status, 'UNAVAILABLE');
  result = new Promise(() => {});
  const started = Date.now();
  assert.equal((await service.quotes()).status, 'UNAVAILABLE');
  assert.ok(Date.now() - started < 500);
  result = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"partial":'));
  } }), { headers: { 'content-type': 'application/json' } });
  const bodyStarted = Date.now();
  assert.equal((await service.quotes()).status, 'UNAVAILABLE');
  assert.ok(Date.now() - bodyStarted < 500);
});
