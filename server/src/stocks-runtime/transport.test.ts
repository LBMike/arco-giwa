import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoint, httpStocksRpc, externalStocksSigner, signerEndpoint, type HttpFetch } from './transport.js';
import { authorizedCall } from '../stocks/chain.js';
import { callDigest, manifestDigest, StocksError } from '../stocks/contracts.js';
import { testManifest, a, h } from '../stocks/test-fixtures.js';

const m = testManifest();
const signerOptions = { url: 'https://signer.example.test', authorization: 'PRIVATE_TEST_TOKEN', deploymentDigest: manifestDigest(m), manifest: m };

test('RPC rejects a response over the byte cap even without an honest Content-Length', async () => {
  for (const headers of [new Headers(), new Headers({ 'content-length': '1' })]) {
    const rpc = httpStocksRpc('https://rpc.example.test', false, async (_url, init) => {
      const { id } = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id, result: 'x'.repeat(4 * 1024 * 1024) }, { headers });
    });
    await assert.rejects(rpc('eth_getLogs', []), /^Error: STOCKS_RPC_UNAVAILABLE$/);
  }
});

test('signer rejects oversized success as uncertain and only an explicit original-ID lookup recovers it', async () => {
  const call = authorizedCall(m, 'mint:bounded-response', 'MINT', a(10), '10');
  const result = { operationId: call.operationId, callDigest: callDigest(call), txHash: h(20) };
  const methods: string[] = [];
  const signer = externalStocksSigner({ ...signerOptions, request: async (url, init) => {
    methods.push(String(init?.method));
    assert.ok(String(url).endsWith(encodeURIComponent(call.operationId)));
    return Response.json(init?.method === 'PUT' ? { ...result, extra: 'x'.repeat(65536) } : result);
  } });
  await assert.rejects(signer.submit(call), error => error instanceof Error && !(error instanceof StocksError)
    && error.message === 'SIGNER_RESPONSE_UNAVAILABLE');
  assert.deepEqual(methods, ['PUT']);
  assert.deepEqual(await signer.lookup(call.operationId), result);
  assert.deepEqual(methods, ['PUT', 'GET']);
});

test('invalid UTF-8 cannot be silently replaced inside an otherwise matching RPC envelope', async () => {
  const rpc = httpStocksRpc('https://rpc.example.test', false, async (_url, init) => {
    const { id } = JSON.parse(String(init?.body));
    return new Response(Buffer.concat([Buffer.from(`{"jsonrpc":"2.0","id":"${id}","result":"`), Buffer.from([0xc3, 0x28]), Buffer.from('"}') ]));
  });
  await assert.rejects(rpc('eth_call', []), /^Error: STOCKS_RPC_UNAVAILABLE$/);
});

test('raw fetch and JSON decoding errors never expose endpoint paths, response contents or signer tokens', async () => {
  for (const request of [async () => { throw Error('PRIVATE_TEST_TOKEN /private-provider-path'); },
    async () => new Response('PRIVATE_RESPONSE_NOT_JSON')]) {
    await assert.rejects(httpStocksRpc('https://rpc.example.test/private-provider-path', false, request)('eth_chainId', []), /^Error: STOCKS_RPC_UNAVAILABLE$/);
    await assert.rejects(externalStocksSigner({ ...signerOptions, request }).lookup('original-id'), /^Error: SIGNER_RESPONSE_UNAVAILABLE$/);
  }
});

test('RPC still rejects a foreign envelope ID and never retries or accepts writes', async () => {
  let calls = 0;
  const rpc = httpStocksRpc('https://rpc.example.test', false, (async () => {
    calls++; return Response.json({ jsonrpc: '2.0', id: 'foreign', result: '0x164ce' });
  }) as HttpFetch);
  await assert.rejects(rpc('eth_chainId', []), /STOCKS_RPC_RESPONSE_UNAVAILABLE/);
  await assert.rejects(rpc('eth_sendRawTransaction', []), /READ_ONLY_RPC_METHOD/);
  assert.equal(calls, 1);
});

test('only signer URLs may use plain HTTP, and only for a single-label private host with an explicit port', () => {
  assert.equal(signerEndpoint('http://arco-stocks-signer:4394').href, 'http://arco-stocks-signer:4394/');
  assert.equal(signerEndpoint('http://signer9:10000/').href, 'http://signer9:10000/');
  assert.equal(signerEndpoint('https://signer.example.test').href, 'https://signer.example.test/');
  for (const value of ['http://arco-stocks-signer', 'http://signer.example.test:4394', 'http://localhost:4394',
    'http://127.0.0.1:4394', 'http://10.0.0.5:4394', 'http://2130706433:4394', 'http://-bad:4394',
    'http://user:pw@arco-stocks-signer:4394', 'http://arco-stocks-signer:4394/?x=1', 'http://arco-stocks-signer:4394/#x',
    'ftp://arco-stocks-signer:4394'])
    assert.throws(() => signerEndpoint(value), /INVALID_STOCKS_ENDPOINT/, value);
  // RPC endpoints keep the HTTPS rule, and the local harness exemption is unchanged.
  assert.throws(() => endpoint('http://arco-stocks-signer:4394'), /INVALID_STOCKS_ENDPOINT/);
  assert.equal(signerEndpoint('http://127.0.0.1:4394', true).hostname, '127.0.0.1');
});
