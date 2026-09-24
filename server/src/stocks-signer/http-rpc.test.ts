import test from 'node:test';
import assert from 'node:assert/strict';
import { StocksError } from '../stocks/contracts.js';
import { a, h } from '../stocks/test-fixtures.js';
import { httpStocksSignerRpc } from './http-rpc.js';

const isCode = (code: string) => (error: unknown) => error instanceof StocksError && error.code === code
  && error.status === 503 && !error.message.includes('PRIVATE_');
const raw = '0x02aabb';

test('allows only the four signer RPC methods and sends one exact JSON-RPC request each', async () => {
  const methods: string[] = [];
  const rpc = httpStocksSignerRpc('https://rpc.example.test/stocks', false, async (url, init) => {
    assert.equal(String(url), 'https://rpc.example.test/stocks');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['content-type'], 'application/json');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ['id', 'jsonrpc', 'method', 'params']);
    assert.equal(body.jsonrpc, '2.0');
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    methods.push(body.method);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_sendRawTransaction' ? h(22) : '0x1' });
  });
  assert.equal(await rpc('eth_chainId', []), '0x1');
  assert.equal(await rpc('eth_getBlockByNumber', ['finalized', true]), '0x1');
  assert.equal(await rpc('eth_getTransactionCount', [a(10), '0x1']), '0x1');
  assert.equal(await rpc('eth_getTransactionCount', [a(10), 'pending']), '0x1');
  assert.equal(await rpc('eth_sendRawTransaction', [raw]), h(22));
  assert.deepEqual(methods, ['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount',
    'eth_getTransactionCount', 'eth_sendRawTransaction']);
});

test('HTTPS is required except explicitly selected loopback HTTP; URL secrets and redirects are refused', async () => {
  const rejects = [
    'http://rpc.example.test', 'ftp://rpc.example.test', 'http://127.0.0.1:8545',
    'https://PRIVATE_USER:PRIVATE_PASSWORD@rpc.example.test',
    'https://rpc.example.test/?PRIVATE_QUERY', 'https://rpc.example.test/#PRIVATE_FRAGMENT',
    'https://rpc.example.test/?', 'https://rpc.example.test/#', 'PRIVATE_INVALID_URL',
  ];
  for (const url of rejects) assert.throws(() => httpStocksSignerRpc(url), isCode('SIGNER_RPC_CONFIGURATION_INVALID'));
  assert.throws(() => httpStocksSignerRpc('http://rpc.example.test', true), isCode('SIGNER_RPC_CONFIGURATION_INVALID'));
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const rpc = httpStocksSignerRpc(`http://${host}:8545`, true, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x164ce' });
    });
    assert.equal(await rpc('eth_chainId', []), '0x164ce');
  }
  let calls = 0;
  const redirected = httpStocksSignerRpc('https://rpc.example.test', false, async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, 'error');
    return Response.redirect('https://other.example.test', 302);
  });
  await assert.rejects(redirected('eth_chainId', []), isCode('SIGNER_RPC_UNAVAILABLE'));
  assert.equal(calls, 1);
});

test('rejects forbidden methods and malformed parameters before any network call', async () => {
  let calls = 0;
  const rpc = httpStocksSignerRpc('https://rpc.example.test', false, async () => {
    calls++; throw Error('UNEXPECTED_FETCH');
  });
  for (const method of ['eth_sendTransaction', 'personal_sign', 'eth_call', 'eth_getLogs', 'net_version'])
    await assert.rejects(rpc(method, []), isCode('SIGNER_RPC_METHOD_FORBIDDEN'));
  for (const [method, params] of [
    ['eth_chainId', [raw]],
    ['eth_getBlockByNumber', ['pending', true]],
    ['eth_getBlockByNumber', ['0x01', false]],
    ['eth_getBlockByNumber', ['0x1', 'true']],
    ['eth_getTransactionCount', [a(0), '0x1']],
    ['eth_getTransactionCount', [a(10), 'latest']],
    ['eth_sendRawTransaction', []],
    ['eth_sendRawTransaction', ['0x']],
    ['eth_sendRawTransaction', ['0x0']],
    ['eth_sendRawTransaction', ['0xGG']],
    ['eth_sendRawTransaction', ['0xAA']],
    ['eth_sendRawTransaction', [raw, raw]],
    ['eth_sendRawTransaction', [`0x${'aa'.repeat(8193)}`]],
  ] as [string, unknown[]][]) await assert.rejects(rpc(method, params), isCode('SIGNER_RPC_REQUEST_INVALID'));
  assert.equal(calls, 0);
});

test('requires matching JSON-RPC id, success result and a valid write hash', async () => {
  for (const value of [
    { jsonrpc: '2.0', id: 'foreign', result: h(1) },
    { jsonrpc: '1.0', result: h(1) },
    { jsonrpc: '2.0', error: { message: 'PRIVATE_SIGNED_BYTES' } },
    { jsonrpc: '2.0', result: h(1), extra: 'PRIVATE_SIGNED_BYTES' },
    { jsonrpc: '2.0' },
    [],
  ]) {
    const rpc = httpStocksSignerRpc('https://rpc.example.test', false, async (_url, init) => {
      const { id } = JSON.parse(String(init?.body));
      return Response.json({ id, ...value });
    });
    await assert.rejects(rpc('eth_chainId', []), isCode('SIGNER_RPC_RESPONSE_INVALID'));
  }
  for (const result of [null, raw, 'PRIVATE_SIGNED_BYTES', h(0)]) {
    const rpc = httpStocksSignerRpc('https://rpc.example.test', false, async (_url, init) => {
      const { id } = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id, result });
    });
    await assert.rejects(rpc('eth_sendRawTransaction', [raw]), isCode('SIGNER_RPC_RESPONSE_INVALID'));
  }
});

test('bounds response bytes and never exposes raw signed bytes or private provider text in errors', async () => {
  let calls = 0;
  for (const request of [
    async () => { calls++; throw Error(`PRIVATE_PROVIDER ${raw}`); },
    async (_url: URL | Request, init?: RequestInit) => {
      calls++;
      const { id } = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: '2.0', id, result: 'x'.repeat(4 * 1024 * 1024) });
    },
    async () => { calls++; return new Response(`PRIVATE_BAD_JSON ${raw}`); },
  ] as (typeof fetch)[]) {
    const rpc = httpStocksSignerRpc('https://rpc.example.test/PRIVATE_PATH', false, request);
    await assert.rejects(rpc('eth_sendRawTransaction', [raw]), error =>
      isCode('SIGNER_RPC_UNAVAILABLE')(error) && !String(error).includes(raw)
      && !String(error).includes('PRIVATE_PATH'));
  }
  assert.equal(calls, 3); // A send failure is never retried by this adapter.
});
