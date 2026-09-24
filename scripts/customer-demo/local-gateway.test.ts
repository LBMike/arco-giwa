import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { customerGateway, CUSTOMER_API, CUSTOMER_RPC, LOCAL_CUSTOMER_API } from './gateway';

const origin = 'http://127.0.0.1:4392';
test('explicit local gateway sends Stocks and SIWE only to4493 while preserving legacy reads and public RPC', async t => {
  const calls: Array<{ url: string; headers: Headers; body?: BodyInit | null }> = [];
  let fallthrough = 0;
  const handler = customerGateway({ origin, localCustomer: true, authEnabled: true, tradesEnabled: true,
    fetcher: async (url, init) => { calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body }); return Response.json({ ok: true }); },
  });
  const server = createServer((req, res) => { void handler(req, res, () => { fallthrough++; res.end('NOT_A_CUSTOMER_RESULT'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const request = (path: string, body?: object, bearer?: string) => new Promise<{ status: number | undefined }>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${address.port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { host: '127.0.0.1:4392', origin,
        ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: bearer } : {}), cookie: 'NEVER_FORWARD' },
    }, res => { res.resume(); res.once('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const token = 'Bearer aaa.bbb.ccc';
  assert.equal((await request('/api/v1/stocks/catalog')).status, 200);
  assert.equal((await request('/api/v1/auth/nonce', { walletAddress: '0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2', domain: '127.0.0.1:4392' })).status, 200);
  assert.equal((await request('/api/v1/stocks/portfolio', undefined, token)).status, 200);
  assert.equal((await request('/api/v1/stocks/quotes', { symbol: 'NVDA', quantity: '1' }, token)).status, 200);
  assert.equal((await request('/api/v1/evm/catalog/91342', undefined, token)).status, 200);
  assert.equal((await request('/__giwa/read-rpc', { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })).status, 200);
  assert.deepEqual(calls.map(c => c.url), [LOCAL_CUSTOMER_API + '/api/v1/stocks/catalog', LOCAL_CUSTOMER_API + '/api/v1/auth/nonce',
    LOCAL_CUSTOMER_API + '/api/v1/stocks/portfolio', LOCAL_CUSTOMER_API + '/api/v1/stocks/quotes', CUSTOMER_API + '/api/v1/evm/catalog/91342', CUSTOMER_RPC]);
  assert.deepEqual(calls.map(c => c.headers.get('authorization')), [null, null, token, token, null, null]);
  assert.ok(calls.every(c => !c.headers.has('cookie')));
  assert.equal((await request('/api/v1/stocks/quotes', { symbol: 'NVDA', quantity: '1' })).status, 401);
  for (const path of ['/api/v1/admin/stocks/trading-control', '/__fixture/wallet', '/api/v1/stocks/quotes?target=https://evil.test']) {
    assert.equal((await request(path, { paused: false }, token)).status, 503);
  }
  assert.equal(calls.length, 6); assert.equal(fallthrough, 0);
});
test('local gateway cannot be selected with another frontend or without both authenticated trading opt-ins', () => {
  for (const options of [{ origin: 'http://localhost:4392' }, { origin: 'http://127.0.0.1:4493' },
    { origin: origin + '/' }, { tradesEnabled: false }, { authEnabled: false, tradesEnabled: false }]) {
    assert.throws(() => customerGateway({ origin, localCustomer: true, authEnabled: true, tradesEnabled: true, ...options }));
  }
});
