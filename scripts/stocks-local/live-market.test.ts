import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveMarket } from './live-market.js';

test('4392 market host exposes NVDA underlying and clock without inventing token pricing', async t => {
  const id = 'TEST_ONLY_ID', secret = 'TEST_ONLY_SECRET';
  const requested: string[] = [];
  const app = await createLiveMarket({
    readCredentials: () => ({ ALPACA_API_KEY_ID: id, ALPACA_API_SECRET_KEY: secret }),
    readMassiveCredentials: () => ({}),
    fetch: async (input, init) => {
      const url = String(input);
      requested.push(url);
      assert.equal(new Headers(init?.headers).get('APCA-API-KEY-ID'), id);
      assert.equal(new Headers(init?.headers).get('APCA-API-SECRET-KEY'), secret);
      if (url === 'https://paper-api.alpaca.markets/v2/clock') {
        const now = Date.now();
        return Response.json({ timestamp: new Date(now).toISOString(), is_open: true,
          next_close: new Date(now + 3600_000).toISOString(), next_open: new Date(now + 86400_000).toISOString() });
      }
      assert.match(url, /^https:\/\/data\.alpaca\.markets\/v2\/stocks\/snapshots\?/);
      return Response.json({ NVDA: { latestTrade: { p: 125.25, t: new Date().toISOString() } } });
    },
  });
  t.after(() => app.close());
  const result = await app.inject({ method: 'GET', url: '/api/v1/stocks/market/NVDA/live' });
  assert.equal(result.statusCode, 200);
  const value = result.json();
  assert.equal(value.underlying.provider, 'ALPACA');
  assert.equal(value.underlying.price, '125.25');
  assert.equal(value.marketSession.state, 'OPEN');
  assert.equal(value.token.indicativePrice, null);
  assert.equal(value.testnetExecution.unitPrice, null);
  assert.deepEqual(requested.length, 2);
  assert.ok(!result.body.includes(secret));
});
