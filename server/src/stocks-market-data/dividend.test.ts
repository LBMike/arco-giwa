import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createStocksMarketDataService } from './service.js';
import { stocksMarketDataPlugin } from './plugin.js';

// Synthetic records only; no provider credentials or live dividend claims.
const TIME = Date.parse('2026-09-17T18:00:00.000Z');
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const record = (fields = '') => `{"status":"OK","results":[{"ticker":"NVDA","currency":"USD","distribution_type":"recurring","ex_dividend_date":"2026-09-10","pay_date":"2026-10-01","cash_amount":0.123456789012345678,"split_adjusted_cash_amount":0.12,"frequency":4${fields}}]}`;

test('latest recurring dividend uses a fixed filtered Massive request and retains exact cash amounts', async () => {
  let calls = 0;
  const service = createStocksMarketDataService({ apiKey: 'TEST_ONLY_KEY', now: () => TIME, fetch: async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.massive.com');
    assert.equal(url.pathname, '/stocks/v1/dividends');
    assert.equal(url.searchParams.get('ticker'), 'NVDA');
    assert.equal(url.searchParams.get('distribution_type'), 'recurring');
    assert.equal(url.searchParams.get('ex_dividend_date.lte'), '2026-09-17');
    assert.equal(url.searchParams.get('sort'), 'ex_dividend_date.desc');
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(url.searchParams.get('apiKey'), null);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer TEST_ONLY_KEY');
    return json(record());
  } });
  const results = await Promise.all(Array.from({ length: 3 }, () => service.dividend('NVDA')));
  assert.equal(calls, 1);
  for (const response of results) {
    assert.equal(response.status, 'AVAILABLE');
    assert.equal(response.provider, 'MASSIVE');
    assert.deepEqual(response.data, { symbol: 'NVDA', currency: 'USD', cashAmount: '0.123456789012345678', splitAdjustedCashAmount: '0.12', frequency: 4, exDividendDate: '2026-09-10', payDate: '2026-10-01' });
    assert.ok(!JSON.stringify(response).includes('TEST_ONLY_KEY'));
  }
});

test('no recurring dividend is hidden and its empty response is cached for 24 hours', async () => {
  let now = TIME; let calls = 0;
  const service = createStocksMarketDataService({ apiKey: 'TEST_ONLY_KEY', now: () => now, fetch: async () => json(++calls === 1 ? '{"status":"OK","results":[]}' : record()) });
  const absent = await service.dividend('NVDA');
  assert.equal(absent.status, 'UNAVAILABLE'); assert.equal(absent.reason, 'NOT_FOUND'); assert.equal(absent.data, null);
  now += 23 * 3600000;
  assert.equal((await service.dividend('NVDA')).status, 'UNAVAILABLE'); assert.equal(calls, 1);
  now += 3600001;
  assert.equal((await service.dividend('NVDA')).status, 'AVAILABLE'); assert.equal(calls, 2);
});

test('discontinued quarterly dividend is hidden, while an annual distribution may be older', async () => {
  const quarterly = record().replace('2026-09-10', '2026-03-01');
  const stale = await createStocksMarketDataService({ apiKey: 'x', now: () => TIME, fetch: async () => json(quarterly) }).dividend('NVDA');
  assert.equal(stale.status, 'UNAVAILABLE'); assert.equal(stale.reason, 'NOT_FOUND'); assert.equal(stale.data, null);
  const annual = record().replace('2026-09-10', '2025-06-01').replace('"frequency":4', '"frequency":1');
  const current = await createStocksMarketDataService({ apiKey: 'x', now: () => TIME, fetch: async () => json(annual) }).dividend('NVDA');
  assert.equal(current.status, 'AVAILABLE'); assert.equal(current.data?.frequency, 1);
});

test('absent split adjustment and pay date remain null without fabricating yield inputs', async () => {
  const body = record().replace(',"pay_date":"2026-10-01"', '').replace(',"split_adjusted_cash_amount":0.12', '');
  const result = await createStocksMarketDataService({ apiKey: 'x', now: () => TIME, fetch: async () => json(body) }).dividend('NVDA');
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.data?.cashAmount, '0.123456789012345678');
  assert.equal(result.data?.splitAdjustedCashAmount, null);
  assert.equal(result.data?.payDate, null);
});

test('malformed, future, nonrecurring, or non-USD payout records fail closed without affecting profiles', async () => {
  for (const body of [
    record().replace('"ticker":"NVDA"', '"ticker":"AAPL"'),
    record().replace('"currency":"USD"', '"currency":"EUR"'),
    record().replace('"distribution_type":"recurring"', '"distribution_type":"special"'),
    record().replace('2026-09-10', '2026-09-18'),
    record().replace('"frequency":4', '"frequency":0'),
    record().replace('"frequency":4', '"frequency":366'),
    record().replace('"frequency":4', '"frequency":4.5'),
    record().replace('"cash_amount":0.123456789012345678', '"cash_amount":0'),
    record().replace('"cash_amount":0.123456789012345678', '"cash_amount":"0.12"'),
    record().replace('2026-09-10', '2026-02-30'),
  ]) {
    const service = createStocksMarketDataService({ apiKey: 'TEST_ONLY_KEY', now: () => TIME, fetch: async input => String(input).includes('/dividends') ? json(body) : json('{"status":"OK","results":{"ticker":"NVDA","market":"stocks","locale":"us","currency_name":"usd","name":"NVIDIA"}}') });
    const dividend = await service.dividend('NVDA');
    assert.equal(dividend.status, 'UNAVAILABLE'); assert.equal(dividend.reason, 'INVALID_RESPONSE'); assert.equal(dividend.data, null);
    assert.equal((await service.profile('NVDA')).status, 'AVAILABLE');
  }
});

test('dividend route validates symbol and query, and unconfigured provider never makes a request', async () => {
  let calls = 0;
  const service = createStocksMarketDataService({ fetch: async () => { calls++; throw new Error('unexpected request'); } });
  const app = Fastify(); await app.register(stocksMarketDataPlugin, { service });
  try {
    assert.equal((await app.inject('/api/v1/stocks/market/NVDA/dividend?all=true')).statusCode, 400);
    assert.equal((await app.inject('/api/v1/stocks/market/AAPL/dividend')).statusCode, 404);
    const response = await app.inject('/api/v1/stocks/market/NVDA/dividend');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'UNCONFIGURED');
    assert.equal(response.json().data, null);
    assert.equal(calls, 0);
  } finally { await app.close(); }
});
