import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { FastifyRequest } from 'fastify';
import { callDigest, manifestDigest, StocksError } from '../stocks/contracts.js';
import { authorizedCall, redemptionCall } from '../stocks/chain.js';
import { a, h, testManifest, TestChain } from '../stocks/test-fixtures.js';
import { stocksSessionResolvers } from './session.js';
import { endpoint, externalStocksSigner, httpStocksRpc, type HttpFetch } from './transport.js';
import { parseStocksRuntimeConfig, configuredStocksRuntime, stocksAutodispatch } from './runtime.js';
import { StocksFinalizedObserver } from './observer.js';
import { StocksObservationHealth } from './health.js';
import { toEventSelector } from 'viem';

const require = createRequire(import.meta.url);
const { sign } = require('jsonwebtoken') as typeof import('jsonwebtoken');
const secret = 'TEST_HARNESS_ONLY_SESSION_SECRET';
function request(token?: string) { return { headers: token ? { authorization: `Bearer ${token}` } : { 'x-operator-token': 'legacy' } } as FastifyRequest; }
function session(extra: Record<string, unknown> = {}) { return sign({ sub: a(10), chainId: 91342, domain: 'app.example.test', ...extra }, secret, { algorithm: 'HS256', expiresIn: '15m' }); }

test('Stocks session resolver binds signed domain, chain, wallet and named operator; body/header roles do not elevate', async () => {
  const resolvers = stocksSessionResolvers(secret, ['app.example.test'], [{ wallet: a(10), operatorId: 'alice', permissions: ['stocks:read'] }]);
  assert.equal((await resolvers.resolveActor(request(session())))?.actorId, `evm:${a(10)}`);
  assert.equal((await resolvers.resolveOperator(request(session())))?.operatorId, 'alice');
  assert.equal(await resolvers.resolveOperator(request()), null);
  for (const token of [session({ chainId: 1 }), session({ domain: 'evil.test' }), session({ sub: 'not-wallet' }), sign({ sub: a(10), domain: 'app.example.test', chainId: 91342 }, secret, { noTimestamp: true }), sign({ sub: a(10), domain: 'app.example.test', chainId: 91342 }, secret, { expiresIn: '1d' })]) assert.equal(await resolvers.resolveActor(request(token)), null);
  assert.equal(await resolvers.resolveOperator(request(session({ sub: a(11), role: 'admin' }))), null);
});

test('Stocks HTTP RPC is read only, validates envelopes, disallows credential URLs and redirects', async () => {
  for (const value of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?q=secret']) assert.throws(() => endpoint(value));
  assert.equal(endpoint('http://127.0.0.1:8545', true).hostname, '127.0.0.1');
  let calls = 0;
  const rpc = httpStocksRpc('https://rpc.example.test', false, (async (_url, init) => { calls++; assert.equal(init?.redirect, 'error'); const body = JSON.parse(String(init?.body)); return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x164ce' }); }) as HttpFetch);
  assert.equal(await rpc('eth_chainId', []), '0x164ce');
  await assert.rejects(() => rpc('eth_sendTransaction', [{}]), /READ_ONLY_RPC_METHOD/);
  assert.equal(calls, 1);
});

test('Signer HTTP ambiguity propagates as UNKNOWN-class failure without automatic retry', async () => {
  const m = testManifest(); let calls = 0;
  const signer = externalStocksSigner({ url: 'https://signer.example.test', authorization: 'TEST_HARNESS_ONLY', deploymentDigest: manifestDigest(m), manifest: m, request: (async () => { calls++; return new Response('', { status: 503 }); }) as HttpFetch });
  await assert.rejects(() => signer.submit(authorizedCall(m, 'mint:test', 'MINT', a(10), '10')), error => error instanceof Error && !(error instanceof StocksError));
  assert.equal(calls, 1);
});

test('Signer protocol binds original call and capability policy; lookup has no side effects', async () => {
  const m = testManifest(); const call = authorizedCall(m, 'mint:test', 'MINT', a(10), '10'); const methods: string[] = [];
  const signer = externalStocksSigner({ url: 'https://signer.example.test', authorization: 'TEST_HARNESS_ONLY', deploymentDigest: manifestDigest(m), manifest: m, request: (async (url, init) => {
    methods.push(String(init?.method));
    if (String(url).endsWith('/capabilities')) return Response.json({ protocol: 'ARCO_STOCKS_SIGNER_V1', profile: 'DEMO_TESTNET', chainId: 91342, signerAddress: m.signerAddress, noncePolicy: 'DURABLE_SERIALIZED', operationPolicy: 'IMMUTABLE_IDEMPOTENT', replacementPolicy: 'DISABLED' });
    if (init?.body) { const body = JSON.parse(String(init.body)); assert.equal(body.callDigest, callDigest(call)); assert.equal(body.deploymentDigest, manifestDigest(m)); }
    return Response.json({ operationId: call.operationId, txHash: h(20), callDigest: callDigest(call) });
  }) as HttpFetch });
  await signer.probe(); assert.equal((await signer.submit(call)).txHash, h(20)); assert.equal((await signer.lookup(call.operationId))?.txHash, h(20));
  assert.deepEqual(methods, ['GET', 'PUT', 'GET']);
});

test('Signer rejects mutated target or operation before HTTP and snapshots configuration', async () => {
  const m = testManifest(); const call = authorizedCall(m, 'mint:test', 'MINT', a(10), '10'); let calls = 0;
  const options = { url: 'https://signer.example.test', authorization: 'ORIGINAL_TEST_TOKEN', deploymentDigest: manifestDigest(m), manifest: m, request: (async (_url, init) => {
    calls++; assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer ORIGINAL_TEST_TOKEN');
    const body = JSON.parse(String(init?.body)); assert.equal(body.deploymentDigest, manifestDigest(m));
    return Response.json({ operationId: body.call.operationId, txHash: h(20), callDigest: body.callDigest });
  }) as HttpFetch };
  const signer = externalStocksSigner(options);
  options.authorization = 'MUTATED'; options.deploymentDigest = '0'.repeat(64);
  for (const bad of [{ ...call, to: a(90) }, { ...call, operationId: 'different' }]) await assert.rejects(() => signer.submit(bad), /SIGNER_CALL_CAPABILITY_MISMATCH/);
  assert.equal(calls, 0);
  for (const valid of [call, authorizedCall(m, 'refund:test', 'REFUND', a(10), '10'), redemptionCall(m, 'redeem:test', 'REDEEM', h(5), '10'), redemptionCall(m, 'return:test', 'RETURN', h(5), '0')]) await signer.submit(valid);
  assert.equal(calls, 4);
});

test('Stocks runtime is absent by default and rejects incomplete or old activation configs', async () => {
  assert.equal(await configuredStocksRuntime({}, 'unused'), null);
  assert.equal(await configuredStocksRuntime({ STOCKS_MODE: 'DISABLED' }, 'unused'), null);
  await assert.rejects(() => configuredStocksRuntime({ STOCKS_MODE: 'MAINNET' }, 'unused'), /INVALID_STOCKS_MODE/);
  assert.throws(() => parseStocksRuntimeConfig({ profile: 'DEMO_TESTNET', manifest: { schemaVersion: 1 } }), /INVALID_STOCKS_ACTIVATION/);
});

test('Operator controls require an explicit boolean and preserve absent legacy configuration', () => {
  const config = { profile: 'DEMO_TESTNET', manifest: testManifest(), rpcUrl: 'https://rpc.example.test',
    signerUrl: 'https://signer.example.test', contractPolicyVerified: true, paused: false, operators: [] };
  assert.equal(Object.prototype.hasOwnProperty.call(parseStocksRuntimeConfig(config), 'operatorControls'), false);
  for (const enabled of [true, false]) assert.equal(parseStocksRuntimeConfig({ ...config, operatorControls: enabled }).operatorControls, enabled);
  for (const invalid of [null, 0, 1, 'true', [], {}]) assert.throws(() => parseStocksRuntimeConfig({ ...config, operatorControls: invalid }), /INVALID_STOCKS_OPERATOR_CONTROLS/);
});

test('Stocks dispatch flags fail closed before file, RPC, signer or database access', async () => {
  for (const mode of [undefined, 'DISABLED', 'DEMO_TESTNET']) for (const flag of [undefined, '0']) assert.equal(stocksAutodispatch({ STOCKS_MODE: mode, STOCKS_AUTODISPATCH: flag }), false);
  assert.equal(stocksAutodispatch({ STOCKS_MODE: 'DEMO_TESTNET', STOCKS_AUTODISPATCH: '1' }), true);
  for (const env of [{ STOCKS_AUTODISPATCH: '1' }, { STOCKS_MODE: 'DISABLED', STOCKS_AUTODISPATCH: '1' }, { STOCKS_MODE: 'DEMO_TESTNET', STOCKS_AUTODISPATCH: 'true' }, { STOCKS_MODE: 'MAINNET' }]) await assert.rejects(() => configuredStocksRuntime(env, 'never-connect'), /STOCKS/);
  assert.equal(await configuredStocksRuntime({ STOCKS_MODE: 'DISABLED', STOCKS_CONFIG_PATH: '/does-not-exist', STOCKS_AUTODISPATCH: '0' }, 'never-connect'), null);
});

test('Observation readiness expires without another tick and immediately closes after failure or clock reversal', () => {
  let now = 100000; const health = new StocksObservationHealth(() => now);
  assert.equal(health.current(), false);
  health.record('CURRENT'); assert.equal(health.current(), true);
  now += 60000; assert.equal(health.current(), true);
  now++; assert.equal(health.current(), false); assert.equal(health.status(), 'STALE');
  health.record('CURRENT'); assert.equal(health.current(), true);
  health.record('WAITING_PROJECTION'); assert.equal(health.current(), false);
  health.record('CURRENT'); now--; assert.equal(health.current(), false);
});

test('Finalized observer retains its cursor for unapplied settlement or nonfinal evidence and resumes idempotently', async () => {
  const m = testManifest(); const rpc = new TestChain(m); rpc.finalizedNumber = '10'; rpc.blocks.set('10', { number: '10', hash: h(10), timestamp: Math.floor(Date.now() / 1000).toString() });
  const digest = manifestDigest(m); let cursor: Record<string, any> | null = null; let projected = false; let pending = true;
  let fundingCount = 0; let unlocked = 0;
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) { unlocked++; return { rows: [], rowCount: 1 }; }
    if (sql.startsWith('INSERT')) { cursor ??= { blockNumber: '1', blockHash: h(1), version: 0, updatedAt: new Date() }; return { rows: [], rowCount: 1 }; }
    if (sql.startsWith('UPDATE')) { cursor = { blockNumber: values[0], blockHash: values[1], version: cursor!.version + 1, updatedAt: new Date() }; return { rows: [], rowCount: 1 }; }
    return { rows: cursor ? [cursor] : [], rowCount: cursor ? 1 : 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const log = (tx: string, topic: string, emitter: string, index: string) => ({ transactionHash: tx, topics: [topic], address: emitter, blockNumber: '0xa', transactionIndex: index, removed: false });
  const observer = new StocksFinalizedObserver(pool, m, digest, rpc, async (method, params) => { assert.equal(method, 'eth_getLogs'); assert.equal((params[0] as { fromBlock: string }).fromBlock, '0x1'); return [log(h(30), toEventSelector('FundingReceived(bytes32,address,address,uint256)'), m.fundingVault, '0x0'), log(h(31), toEventSelector('StockMinted(bytes32,address,address,uint256)'), m.mintController, '0x1')]; }, { observeFunding: async () => { fundingCount++; return pending ? { status: 'FINALITY_PENDING' } : {}; }, observeEscrow: async () => ({}), isTransactionProjected: async () => projected });
  await assert.rejects(() => observer.runOnce(), /OBSERVER_FUNDING_NOT_FINAL/); assert.equal(await observer.coverage(), null);
  pending = false;
  assert.equal(await observer.runOnce(), 'WAITING_PROJECTION'); assert.equal(await observer.coverage(), null);
  projected = true; assert.equal(await observer.runOnce(), 'CURRENT'); assert.equal((await observer.coverage())?.throughBlock, '10');
  assert.equal(fundingCount, 3); assert.equal(unlocked, 3);
  rpc.blocks.set('10', { number: '10', hash: h(99), timestamp: Math.floor(Date.now() / 1000).toString() });
  await assert.rejects(() => observer.runOnce(), /OBSERVER_CURSOR_OR_FINALITY_INVALID/); assert.equal(unlocked, 4);
});
