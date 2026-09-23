import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { publicReadGateway, publicUpstream, readTarget } from './gateway.mjs';
const origin = 'http://127.0.0.1:5173', legacy = 'https://legacy.example', market = 'http://127.0.0.1:4392';
function response() { const r = new EventEmitter(); r.writeHead = (status, headers) => { r.status = status; r.headers = headers; }; r.end = body => { r.body = String(body); }; return r; }
test('routes public GIWA products and encoded market queries; refuses execution and arbitrary paths', () => {
  assert.equal(readTarget('/api/v1/evm/catalog/91342', legacy, market), legacy + '/api/v1/evm/catalog/91342');
  assert.equal(readTarget('/api/v1/stocks/market/quotes?symbols=NVDA%2CAAPL', legacy, market), market + '/api/v1/stocks/market/quotes?symbols=NVDA%2CAAPL');
  for (const path of ['/api/v1/auth/nonce', '/api/v1/stocks/orders', '/__fixture/control', '//evil.example/', '/api/v1/evm/catalog/1', '/api/v1/evm/%63atalog/91342', '/api/v1/admin/monitoring/91342/overview']) assert.equal(readTarget(path, legacy, market), null, path);
});
test('only configured origins and GET reads reach upstream; no credentials forwarded', async () => {
  const calls = []; const handler = publicReadGateway({ origin, legacy, market, fetcher: async (...args) => { calls.push(args); return Response.json({ products: ['original'] }); } });
  const run = async (change = {}) => { const res = response(); await handler({ url: '/api/v1/evm/catalog/91342', method: 'GET', headers: { host: '127.0.0.1:5173', origin, authorization: 'private', cookie: 'private' }, ...change }, res, () => {}); return res; };
  assert.equal((await run()).status, 200);
  assert.deepEqual(calls[0][1].headers, { accept: 'application/json' });
  assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[0][1].credentials, 'omit');
  assert.equal((await run({ method: 'POST' })).status, 405);
  assert.equal((await run({ headers: { host: '127.0.0.1:5173', origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await run({ url: '/api/v1/stocks/catalog' })).status, 503);
  assert.equal(calls.length, 1);
});
test('upstream errors and oversized responses cannot leak upstream bodies', async () => {
  for (const fetcher of [async () => { throw new Error('private'); }, async () => new Response('private'), async () => new Response('x'.repeat(4_000_001), { headers: { 'content-type': 'application/json' } })]) {
    const res = response(); await publicReadGateway({ origin, legacy, market, fetcher })({ method: 'GET', url: '/api/v1/evm/catalog/91342', headers: { host: '127.0.0.1:5173' } }, res, () => {});
    assert.equal(res.status, 502); assert.equal(res.body, '{"error":"PUBLIC_DATA_UNAVAILABLE"}');
  }
});
test('a market outage is unavailable, then the same gateway reads the recovered market', async () => {
  let available = false;
  const handler = publicReadGateway({ origin, legacy, market, fetcher: async url => {
    assert.equal(url, `${market}/api/v1/stocks/market/catalog`);
    if (!available) throw new Error('market offline');
    return Response.json({ provider: 'ALPACA', marketFeed: 'IEX' });
  } });
  const run = async () => {
    const res = response();
    await handler({ method: 'GET', url: '/api/v1/stocks/market/catalog', headers: { host: '127.0.0.1:5173' } }, res, () => {});
    return res;
  };
  const unavailable = await run();
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.body, '{"error":"PUBLIC_DATA_UNAVAILABLE"}');
  available = true;
  const recovered = await run();
  assert.equal(recovered.status, 200);
  assert.deepEqual(JSON.parse(recovered.body), { provider: 'ALPACA', marketFeed: 'IEX' });
});
test('upstream settings reject credentials, paths and non-local market hosts', () => {
  assert.equal(publicUpstream(market, true), market);
  for (const value of ['https://u:p@example.com', 'file:///tmp/data', 'http://public.example', 'https://example.com/path', 'https://example.com/?token=x']) assert.throws(() => publicUpstream(value));
  assert.throws(() => publicUpstream('https://example.com', true));
});
