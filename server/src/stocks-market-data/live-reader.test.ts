import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKET_CONTEXT, type MarketResponse, type Quote } from './contracts.js';
import { createNvdaLiveReader } from './live-reader.js';
import type { NvdaMarketSession } from './live-snapshot.js';
import type { StocksMarketDataService } from './service.js';

const START = Date.parse('2026-09-24T22:00:00.000Z');
const SOURCE = '2026-09-24T19:59:00.000Z';
const row = (overrides: Partial<Quote> = {}): Quote => ({
  symbol: 'NVDA', currency: 'USD', price: '125.25', change: '5.25', changePercent: '4.375',
  sessionVolume: '1000', previousClose: '120', sourceTimestamp: SOURCE,
  observationAgeMs: 2 * 60 * 60_000, priceSource: 'LAST_TRADE', status: 'AVAILABLE', reason: null,
  ...overrides,
});
const response = (quote: Quote): MarketResponse<Quote[]> => ({
  ...MARKET_CONTEXT, provider: 'ALPACA', marketFeed: 'IEX', status: 'AVAILABLE', reason: null,
  fetchedAt: '2026-09-24T22:00:00.000Z', cacheAgeMs: 0, feedDelay: 'REALTIME', data: [quote],
});
const service = (quotes: () => Promise<MarketResponse<Quote[]>>): StocksMarketDataService => ({ quotes }) as StocksMarketDataService;
const session = (state: NvdaMarketSession['state'], now: number): NvdaMarketSession => state === 'UNKNOWN'
  ? { state, observedAt: null, nextOpen: null, nextClose: null }
  : { state, observedAt: new Date(now).toISOString(), nextOpen: new Date(now + (state === 'CLOSED' ? 15 : 21) * 60 * 60_000).toISOString(), nextClose: new Date(now + (state === 'CLOSED' ? 21 : 2) * 60 * 60_000).toISOString() };

test('closed session reuses the observation for less than 15 minutes, advances its age, marks it stale, and refreshes the catalog', async () => {
  let now = START, quoteReads = 0, clockReads = 0, catalogPrice = '120.000000';
  const read = createNvdaLiveReader({
    marketData: service(async () => response(row({ price: String(125.25 + quoteReads++) }))),
    marketClock: { get: async () => { clockReads++; return session('CLOSED', now); } },
    executionCatalog: () => ({ instruments: [{ symbol: 'NVDA', price: catalogPrice, priceSource: 'FIXED_MOCK_PRICE', orderCapability: 'CHECK_PAUSE_AT_ORDER' }] }),
    now: () => now,
  });
  const first = await read();
  assert.equal(first.underlying.price, '125.25');
  assert.equal(first.underlying.status, 'AVAILABLE');
  assert.equal(first.underlying.sourceTimestamp, SOURCE);
  now += 14 * 60_000 + 59_000;
  catalogPrice = '121.000000';
  const reused = await read();
  assert.equal(reused.underlying.price, '125.25');
  assert.equal(reused.underlying.status, 'STALE');
  assert.equal(reused.underlying.reason, 'OLD_OBSERVATION');
  assert.equal(reused.underlying.sourceTimestamp, SOURCE);
  assert.equal(reused.underlying.observationAgeMs, now - Date.parse(SOURCE));
  assert.equal(reused.testnetExecution.unitPrice, '121.000000');
  assert.equal(reused.token.indicativePrice, null);
  assert.equal(quoteReads, 1);
  assert.equal(clockReads, 2);
  now += 1000;
  const refreshed = await read();
  assert.equal(refreshed.underlying.price, '126.25');
  assert.equal(quoteReads, 2);
  assert.equal(clockReads, 2);
});

test('open and unknown sessions read fresh quotes and reopening discards closed cache', async () => {
  let now = START, quoteReads = 0, marketState: NvdaMarketSession['state'] = 'CLOSED';
  const read = createNvdaLiveReader({
    marketData: service(async () => response(row({ price: String(125 + ++quoteReads) }))),
    marketClock: { get: async () => session(marketState, now) },
    now: () => now,
  });
  assert.equal((await read()).underlying.price, '126');
  now += 15 * 60 * 60_000;
  marketState = 'OPEN';
  assert.equal((await read()).underlying.price, '127');
  assert.equal((await read()).underlying.price, '128');
  marketState = 'UNKNOWN';
  assert.equal((await read()).underlying.price, '129');
  marketState = 'CLOSED';
  assert.equal((await read()).underlying.price, '130');
  assert.equal(quoteReads, 5);
});

test('invalid or expired CLOSED clock cannot suppress quote refresh', async () => {
  let now = START, quoteReads = 0;
  const staleClock = session('CLOSED', START - 4 * 60_000);
  const read = createNvdaLiveReader({
    marketData: service(async () => response(row({ price: String(++quoteReads) }))),
    marketClock: { get: async () => staleClock },
    now: () => now,
  });
  assert.equal((await read()).marketSession.state, 'UNKNOWN');
  now += 1000;
  assert.equal((await read()).underlying.price, '2');
  assert.equal(quoteReads, 2);
});

test('a market opening crossed while waiting for the clock invalidates closed reuse', async () => {
  let now = START, quoteReads = 0, opening = false;
  const read = createNvdaLiveReader({
    marketData: service(async () => response(row({ price: String(++quoteReads) }))),
    marketClock: { get: async () => {
      const clock = session('CLOSED', now);
      if (opening) now = Date.parse(clock.nextOpen!);
      return clock;
    } },
    now: () => now,
  });
  assert.equal((await read()).underlying.price, '1');
  now += 5 * 60_000;
  opening = true;
  const crossed = await read();
  assert.equal(crossed.marketSession.state, 'UNKNOWN');
  assert.equal(crossed.underlying.price, '2');
  assert.equal(quoteReads, 2);
});

test('closed clock cache expires at the announced next opening even before five minutes', async () => {
  let now = START, clockReads = 0, quoteReads = 0;
  const read = createNvdaLiveReader({
    marketData: service(async () => response(row({ price: String(++quoteReads) }))),
    marketClock: { get: async () => {
      clockReads++;
      if (clockReads > 1) return session('OPEN', now);
      return {
        state: 'CLOSED', observedAt: new Date(now).toISOString(),
        nextOpen: new Date(now + 2 * 60_000).toISOString(),
        nextClose: new Date(now + 8 * 60 * 60_000).toISOString(),
      };
    } },
    now: () => now,
  });
  assert.equal((await read()).marketSession.state, 'CLOSED');
  now += 60_000;
  assert.equal((await read()).marketSession.state, 'CLOSED');
  assert.equal(clockReads, 1);
  now += 60_000;
  const reopened = await read();
  assert.equal(reopened.marketSession.state, 'OPEN');
  assert.equal(reopened.underlying.price, '2');
  assert.equal(clockReads, 2);
  assert.equal(quoteReads, 2);
});

test('failed closed-session quote is not held for fifteen minutes; stale failure reason is preserved', async () => {
  let now = START, quoteReads = 0;
  const read = createNvdaLiveReader({
    marketData: service(async () => {
      quoteReads++;
      if (quoteReads === 1) throw new Error('secret-provider-key');
      return response(row({ status: 'STALE', reason: 'PROVIDER_RATE_LIMITED' }));
    }),
    marketClock: { get: async () => session('CLOSED', now) },
    now: () => now,
  });
  const failed = await read();
  assert.equal(failed.underlying.status, 'UNAVAILABLE');
  assert.ok(!JSON.stringify(failed).includes('secret-provider-key'));
  const stale = await read();
  assert.equal(stale.underlying.status, 'STALE');
  assert.equal(stale.underlying.reason, 'PROVIDER_RATE_LIMITED');
  now += 60_000;
  const reused = await read();
  assert.equal(reused.underlying.reason, 'PROVIDER_RATE_LIMITED');
  assert.equal(reused.underlying.price, '125.25');
  assert.equal(quoteReads, 2);
});

test('concurrent reads share one underlying quote request but each returns a fresh snapshot', async () => {
  let now = START, quoteReads = 0, clockReads = 0, catalogReads = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = createNvdaLiveReader({
    marketData: service(async () => { quoteReads++; await gate; return response(row()); }),
    marketClock: { get: async () => { clockReads++; return session('CLOSED', now); } },
    executionCatalog: () => { catalogReads++; return { instruments: [{ symbol: 'NVDA', price: '120', priceSource: 'FIXED_MOCK_PRICE', orderCapability: 'CHECK_PAUSE_AT_ORDER' }] }; },
    now: () => now,
  });
  const first = read(), second = read();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quoteReads, 1);
  release?.();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.underlying.price, '125.25');
  assert.equal(b.underlying.price, '125.25');
  assert.equal(clockReads, 2);
  assert.equal(catalogReads, 2);
  now += 1000;
  assert.equal((await read()).underlying.status, 'STALE');
  assert.equal(quoteReads, 1);
});

test('closed refresh interval is bounded to fifteen minutes', () => {
  assert.throws(() => createNvdaLiveReader({ marketData: service(async () => response(row())), closedQuoteRefreshMs: 900_001 }), /INVALID_NVDA_LIVE_READER_CONFIG/);
});
