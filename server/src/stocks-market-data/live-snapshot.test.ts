import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKET_CONTEXT, type MarketResponse, type Quote } from './contracts.js';
import type { StocksMarketDataService } from './service.js';
import { createNvdaLiveSnapshot } from './live-snapshot.js';

const NOW = Date.parse('2026-09-24T18:00:00.000Z');
const row = (overrides: Partial<Quote> = {}): Quote => ({ symbol: 'NVDA', currency: 'USD', price: '125.25', change: '5.25', changePercent: '4.375', sessionVolume: '1000', previousClose: '120', sourceTimestamp: '2026-09-24T17:59:30.000Z', observationAgeMs: 30000, priceSource: 'LAST_TRADE', status: 'AVAILABLE', reason: null, ...overrides });
const response = (rows: Quote[], overrides: Partial<MarketResponse<Quote[]>> = {}): MarketResponse<Quote[]> => ({ ...MARKET_CONTEXT, provider: 'ALPACA', marketFeed: 'IEX', status: 'AVAILABLE', reason: null, fetchedAt: '2026-09-24T17:59:40.000Z', cacheAgeMs: 20000, feedDelay: 'REALTIME', data: rows, ...overrides });
const service = (result: MarketResponse<Quote[]>): StocksMarketDataService => ({ quotes: async () => result }) as unknown as StocksMarketDataService;
const catalog = () => ({ instruments: [{ symbol: 'NVDA', price: '120.000000', priceSource: 'FIXED_MOCK_PRICE', orderCapability: 'CHECK_PAUSE_AT_ORDER' }] });

test('NVDA snapshot separates underlying price, market session, token indication and catalog-only mock price', async () => {
  const snapshot = await createNvdaLiveSnapshot({ marketData: service(response([row()])), marketClock: { get: async () => ({ state: 'OPEN', observedAt: '2026-09-24T17:59:59.000Z', nextOpen: '2026-09-25T13:30:00.000Z', nextClose: '2026-09-24T20:00:00.000Z' }) }, executionCatalog: catalog, now: () => NOW });
  assert.equal(snapshot.observedAt, '2026-09-24T18:00:00.000Z');
  assert.deepEqual(snapshot.underlying, { basis: 'UNDERLYING_SECURITY', currency: 'USD', price: '125.25', change: '5.25', changePercent: '4.375', sessionVolume: '1000', previousClose: '120', observationAgeMs: 30000, status: 'AVAILABLE', reason: null, sourceTimestamp: '2026-09-24T17:59:30.000Z', priceSource: 'LAST_TRADE', provider: 'ALPACA', marketFeed: 'IEX', feedDelay: 'REALTIME' });
  assert.equal(snapshot.marketSession.state, 'OPEN');
  assert.deepEqual(snapshot.token, { basis: 'ARCO_TOKEN', indicativePrice: null, status: 'UNAVAILABLE' });
  assert.deepEqual(snapshot.testnetExecution, { mode: 'FIXED_MOCK_PRICE', status: 'CATALOG_ONLY', unitPrice: '120.000000', quoteRequired: true });
  assert.ok(!JSON.stringify(snapshot).includes('CHECK_PAUSE_AT_ORDER'));
});

test('NVDA row status remains stale even when the batch envelope is available; closed market is independent', async () => {
  const snapshot = await createNvdaLiveSnapshot({ marketData: service(response([row({ status: 'STALE', reason: 'OLD_OBSERVATION' })])), marketClock: { get: async () => ({ state: 'CLOSED', observedAt: '2026-09-24T22:00:00.000Z', nextOpen: '2026-09-25T13:30:00.000Z', nextClose: '2026-09-25T20:00:00.000Z' }) }, now: () => NOW });
  assert.equal(snapshot.underlying.status, 'STALE');
  assert.equal(snapshot.underlying.reason, 'OLD_OBSERVATION');
  assert.equal(snapshot.underlying.price, '125.25');
  assert.equal(snapshot.underlying.changePercent, '4.375');
  assert.equal(snapshot.underlying.observationAgeMs, 30000);
  assert.equal(snapshot.marketSession.state, 'CLOSED');
  assert.equal(snapshot.testnetExecution.unitPrice, null);
});

test('missing NVDA observation never substitutes another symbol or previous close', async () => {
  const missing = await createNvdaLiveSnapshot({ marketData: service(response([row({ symbol: 'AAPL', previousClose: '999' })])), now: () => NOW });
  assert.equal(missing.underlying.price, null);
  assert.equal(missing.underlying.change, null);
  assert.equal(missing.underlying.changePercent, null);
  assert.equal(missing.underlying.sessionVolume, null);
  assert.equal(missing.underlying.previousClose, null);
  assert.equal(missing.underlying.observationAgeMs, null);
  assert.equal(missing.underlying.sourceTimestamp, null);
  assert.equal(missing.underlying.status, 'UNAVAILABLE');
  assert.equal(missing.marketSession.state, 'UNKNOWN');
  const noPrice = await createNvdaLiveSnapshot({ marketData: service(response([row({ price: null, status: 'UNAVAILABLE', reason: 'MISSING_OBSERVATION', previousClose: '120' })])), now: () => NOW });
  assert.equal(noPrice.underlying.price, null);
  assert.equal(noPrice.underlying.previousClose, '120');
  assert.equal(noPrice.underlying.status, 'UNAVAILABLE');
  assert.equal(noPrice.underlying.reason, 'MISSING_OBSERVATION');
});

test('clock and provider failures are isolated and do not leak exception text', async () => {
  const marketData = { quotes: async () => { throw new Error('secret-provider-key'); } } as unknown as StocksMarketDataService;
  const snapshot = await createNvdaLiveSnapshot({ marketData, marketClock: { get: async () => { throw new Error('secret-clock-key'); } }, executionCatalog: () => { throw new Error('secret-catalog-key'); }, now: () => NOW });
  assert.equal(snapshot.underlying.status, 'UNAVAILABLE');
  assert.equal(snapshot.underlying.price, null);
  assert.equal(snapshot.underlying.change, null);
  assert.equal(snapshot.underlying.changePercent, null);
  assert.equal(snapshot.underlying.sessionVolume, null);
  assert.equal(snapshot.underlying.previousClose, null);
  assert.equal(snapshot.underlying.observationAgeMs, null);
  assert.equal(snapshot.marketSession.state, 'UNKNOWN');
  assert.equal(snapshot.testnetExecution.unitPrice, null);
  assert.ok(!JSON.stringify(snapshot).includes('secret-'));
});

test('unconfigured provider and non-mock catalog price remain unavailable', async () => {
  const snapshot = await createNvdaLiveSnapshot({ marketData: service(response([], { status: 'UNCONFIGURED', reason: 'NOT_CONFIGURED', data: null })), executionCatalog: () => ({ instruments: [{ symbol: 'NVDA', price: '125.25', priceSource: 'UNDERLYING_SECURITY', orderCapability: 'CHECK_PAUSE_AT_ORDER' }] }), now: () => NOW });
  assert.equal(snapshot.underlying.status, 'UNCONFIGURED');
  assert.equal(snapshot.underlying.reason, 'NOT_CONFIGURED');
  assert.equal(snapshot.testnetExecution.status, 'UNAVAILABLE');
});
