// Real loopback HTTP with production adapters; no DB, keys or chain writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { stocksHttpJson } from '../../server/dist/stocks-runtime/http-json.js';
import { externalStocksSigner, httpStocksRpc } from '../../server/dist/stocks-runtime/transport.js';
import { authorizedCall } from '../../server/dist/stocks/chain.js';
import { callDigest, manifestDigest } from '../../server/dist/stocks/contracts.js';
import { testManifest, a, h } from '../../server/dist/stocks/test-fixtures.js';

async function server(t, handler) {
  const instance = createServer(handler);
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => {
    instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${instance.address().port}`;
}

test('native fetch body timeout cancels a stalled socket instead of hanging shutdown', { timeout: 5000 }, async t => {
  let contacted = false, closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const url = await server(t, (_request, response) => {
    contacted = true; response.on('close', closed);
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{');
  });
  await assert.rejects(stocksHttpJson(new URL(url), {}, {
    maxBytes: 64, errorCode: 'STOCKS_RPC_UNAVAILABLE', timeoutMs: 1000,
  }), /^Error: STOCKS_RPC_UNAVAILABLE$/);
  assert.equal(contacted, true);
  await disconnected;
});

test('RPC byte cap applies to decompressed native HTTP bodies', async t => {
  const url = await server(t, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const { id } = JSON.parse(Buffer.concat(chunks));
    const bytes = gzipSync(JSON.stringify({ jsonrpc: '2.0', id, result: 'x'.repeat(4 * 1024 * 1024) }));
    assert.ok(bytes.length < 64 * 1024);
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': bytes.length });
    response.end(bytes);
  });
  await assert.rejects(httpStocksRpc(url, true)('eth_getLogs', []), /^Error: STOCKS_RPC_UNAVAILABLE$/);
});

test('native signer lost JSON response leaves one PUT; explicit lookup uses the same operation ID', async t => {
  const m = testManifest(), call = authorizedCall(m, 'mint:original-native-id', 'MINT', a(10), '10');
  const result = { operationId: call.operationId, callDigest: callDigest(call), txHash: h(20) };
  const requests = [];
  const url = await server(t, async (request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method === 'PUT') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.callDigest, result.callDigest);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"txHash":"TRUNCATED_PRIVATE_RESPONSE');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    }
  });
  const signer = externalStocksSigner({ url, localHarness: true, authorization: 'TEST_ONLY', manifest: m, deploymentDigest: manifestDigest(m) });
  await assert.rejects(signer.submit(call), /^Error: SIGNER_RESPONSE_UNAVAILABLE$/);
  assert.equal(requests.length, 1);
  assert.deepEqual(await signer.lookup(call.operationId), result);
  assert.deepEqual(requests, ['PUT', 'GET'].map(method => ({ method, url: `/v1/operations/${encodeURIComponent(call.operationId)}` })));
});
