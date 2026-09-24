import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MARKET_CONTEXT, type MarketResponse, type Quote } from './contracts.js';
import { stocksMarketDataPlugin } from './plugin.js';
import type { StocksMarketDataService } from './service.js';
import { buildApp, type ArcoAppServices } from '../app.js';

const NOW = new Date().toISOString();
const NEXT_CLOSE = new Date(Date.parse(NOW) + 2 * 60 * 60_000).toISOString();
const NEXT_OPEN = new Date(Date.parse(NOW) + 21 * 60 * 60_000).toISOString();
const quote: Quote = {
  symbol: 'NVDA', currency: 'USD', price: '125.25', change: '5.25', changePercent: '4.375',
  sessionVolume: '1000', previousClose: '120', sourceTimestamp: NOW, observationAgeMs: 0,
  priceSource: 'LAST_TRADE', status: 'AVAILABLE', reason: null,
};
const response: MarketResponse<Quote[]> = {
  ...MARKET_CONTEXT, provider: 'ALPACA', marketFeed: 'IEX', status: 'AVAILABLE', reason: null,
  fetchedAt: NOW, cacheAgeMs: 0, feedDelay: 'REALTIME', data: [quote],
};

test('normal product app preserves explicit Vercel and UI4392 CORS on real HTTP SSE', { timeout: 10_000 }, async t => {
  const allowed = ['https://app.arco.financial', 'http://127.0.0.1:4392'];
  const service = {
    catalog: () => ({ ...response, data: { securities: [{ symbol: 'NVDA', name: 'NVIDIA' }], provenance: { sourceUrl: null, rankingMetric: null, period: null, asOfDate: null, verification: 'PILOT' } } }),
    quotes: async () => response,
  } as unknown as StocksMarketDataService;
  const app = buildApp({ corsAllowedOrigins: allowed, authNonceTtlSeconds: 60,
    authJwtSecret: 'TEST_ONLY_CORS', adminOperatorToken: 'TEST_ONLY_OPERATOR', registryPath: '/NO_REGISTRY' }, {
    arco: {}, registry: {}, portfolio: {}, readiness: {}, stocksMarketData: service,
  } as unknown as ArcoAppServices);
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  for (const origin of [...allowed, 'https://untrusted.example']) {
    const answer = await fetch(base + '/api/v1/stocks/market/NVDA/live/stream', {
      headers: { origin }, signal: AbortSignal.timeout(2000),
    });
    try {
      if (!allowed.includes(origin)) {
        assert.ok(answer.status >= 400);
        assert.equal(answer.headers.get('access-control-allow-origin'), null);
        assert.doesNotMatch(answer.headers.get('content-type') ?? '', /text\/event-stream/);
        continue;
      }
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get('access-control-allow-origin'), origin);
      assert.notEqual(answer.headers.get('access-control-allow-credentials'), 'true');
      assert.match(answer.headers.get('vary') ?? '', /origin/i);
      assert.match(answer.headers.get('content-type') ?? '', /^text\/event-stream/);
      const reader = answer.body!.getReader();
      try {
        let body = '';
        while (!body.includes('event: snapshot')) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          body += new TextDecoder().decode(chunk.value);
        }
        assert.match(body, /"symbol":"NVDA"/);
      } finally { await reader.cancel(); }
    } finally { if (!answer.body?.locked) await answer.body?.cancel(); }
  }
});

function fixture(setup?: (app: FastifyInstance) => void) {
  let calls = 0;
  const service = {
    catalog: () => ({ ...response, data: { securities: [{ symbol: 'NVDA', name: 'NVIDIA' }], provenance: { sourceUrl: null, rankingMetric: null, period: null, asOfDate: null, verification: 'PILOT' } } }),
    quotes: async () => { calls++; return response; },
  } as unknown as StocksMarketDataService;
  const app = Fastify({ logger: false });
  setup?.(app);
  app.register(stocksMarketDataPlugin, {
    service,
    marketClock: { get: async () => ({ state: 'OPEN', observedAt: NOW, nextOpen: NEXT_OPEN, nextClose: NEXT_CLOSE }) },
    executionCatalog: () => ({ instruments: [{ symbol: 'NVDA', price: '120.000000', priceSource: 'FIXED_MOCK_PRICE', orderCapability: 'CHECK_PAUSE_AT_ORDER' }] }),
  });
  return { app, calls: () => calls };
}

test('NVDA live route gives separate read-only price lanes and rejects unexpected query fields', async t => {
  const { app } = fixture();
  t.after(() => app.close());
  const answer = await app.inject({ method: 'GET', url: '/api/v1/stocks/market/NVDA/live' });
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.headers['cache-control'], 'no-store');
  const body = answer.json();
  assert.equal(body.underlying.price, '125.25');
  assert.equal(body.underlying.provider, 'ALPACA');
  assert.equal(body.marketSession.state, 'OPEN');
  assert.equal(body.token.indicativePrice, null);
  assert.equal(body.testnetExecution.unitPrice, '120.000000');
  assert.equal(body.testnetExecution.quoteRequired, true);
  assert.ok(!answer.body.includes('CHECK_PAUSE_AT_ORDER'));
  const bad = await app.inject({ method: 'GET', url: '/api/v1/stocks/market/NVDA/live?apiKey=secret' });
  assert.equal(bad.statusCode, 400);
  assert.ok(!bad.body.includes('secret'));
});

test('SSE sends an NVDA snapshot and server close drains the connection', async () => {
  const { app, calls } = fixture();
  const pending = app.inject({ method: 'GET', url: '/api/v1/stocks/market/NVDA/live/stream' });
  await new Promise(resolve => setTimeout(resolve, 25));
  await app.close();
  const answer = await pending;
  assert.equal(answer.statusCode, 200);
  assert.match(String(answer.headers['content-type']), /^text\/event-stream/);
  assert.match(answer.body, /event: snapshot\ndata: /);
  assert.match(answer.body, /"symbol":"NVDA"/);
  assert.equal(calls(), 1);
});

test('SSE releases a late subscriber closed during cached snapshot delivery', async () => {
  const stream = '/api/v1/stocks/market/NVDA/live/stream';
  let firstSnapshotWritten!: () => void;
  const firstSnapshot = new Promise<void>(resolve => { firstSnapshotWritten = resolve; });
  let allRequestsArrived!: () => void;
  const arrivals = new Promise<void>(resolve => { allRequestsArrived = resolve; });
  let streamRequests = 0;
  let forcedBackpressure = 0;
  const { app } = fixture(app => {
    app.addHook('onRequest', (request, reply, done) => {
      if (request.url !== stream) return done();
      if (++streamRequests === 65) allRequestsArrived();
      const originalWrite = reply.raw.write;
      reply.raw.write = ((...args: unknown[]) => {
        const written = Reflect.apply(originalWrite, reply.raw, args) as boolean;
        if (String(args[0]).startsWith('event: snapshot')) {
          if (request.headers['x-simulate-backpressure'] === '1') {
            forcedBackpressure++;
            return false;
          }
          firstSnapshotWritten();
        }
        return written;
      }) as typeof reply.raw.write;
      done();
    });
  });

  const first = app.inject({ method: 'GET', url: stream });
  let second: Awaited<typeof first> | undefined;
  let remaining: Array<Promise<Awaited<typeof first>>> = [];
  try {
    await firstSnapshot;
    second = await app.inject({ method: 'GET', url: stream, headers: { 'x-simulate-backpressure': '1' } });
    remaining = Array.from({ length: 63 }, () => app.inject({ method: 'GET', url: stream }));
    await arrivals;
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    await app.close();
  }

  assert.equal(second?.statusCode, 200);
  assert.equal(forcedBackpressure, 1);
  assert.equal((await first).statusCode, 200);
  assert.deepEqual((await Promise.all(remaining)).map(answer => answer.statusCode), Array(63).fill(200));
});
