import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { authorizedCall } from '../stocks/chain.js';
import { callDigest, manifestDigest, StocksError, type AuthorizedCall } from '../stocks/contracts.js';
import { a, h, testManifest } from '../stocks/test-fixtures.js';
import { externalStocksSigner, type HttpFetch } from '../stocks-runtime/transport.js';
import { createStocksSignerCore, type DurableSignerJournal, type SignerOperation } from './core.js';
import { createStocksSignerHttpService } from './http-service.js';

const manifest = testManifest();
const digest = manifestDigest(manifest);
const token = randomBytes(32).toString('base64url');
const auth = { authorization: `Bearer ${token}` };
const request = (call: AuthorizedCall) => ({ protocol: 'ARCO_STOCKS_SIGNER_V1', deploymentDigest: digest,
  callDigest: callDigest(call), call });

class Journal implements DurableSignerJournal {
  rows = new Map<string, SignerOperation>();
  async reserve(input: Omit<SignerOperation, 'originalNonce' | 'txHash'>) {
    const previous = this.rows.get(input.operationId);
    if (previous) {
      if (previous.callDigest !== input.callDigest) throw new StocksError('SIGNER_IMMUTABLE_OPERATION_CONFLICT', 409);
      return { created: false, operation: structuredClone(previous) };
    }
    const row = { ...structuredClone(input), originalNonce: String(this.rows.size), txHash: null };
    this.rows.set(input.operationId, row);
    return { created: true, operation: structuredClone(row) };
  }
  async read(operationId: string) { return structuredClone(this.rows.get(operationId) ?? null); }
  async recordHash(operationId: string, expectedDigest: string, txHash: string) {
    const row = this.rows.get(operationId);
    assert.ok(row);
    assert.equal(row.callDigest, expectedDigest);
    assert.ok(row.txHash === null || row.txHash === txHash);
    const saved = { ...row, txHash };
    this.rows.set(operationId, saved);
    return structuredClone(saved);
  }
}

function fixture(options: { ready?: () => Promise<boolean>; send?: () => Promise<string> } = {}) {
  const journal = new Journal();
  let sends = 0;
  let checks = 0;
  const core = createStocksSignerCore({ manifest, journal, transport: {
    sendOnce: async () => { sends++; return options.send ? options.send() : h(50); },
    findOriginal: async () => null,
  } });
  const app = createStocksSignerHttpService({ manifest, core, bearerToken: token,
    ready: async () => { checks++; return options.ready ? options.ready() : true; } });
  return { app, journal, get sends() { return sends; }, get checks() { return checks; } };
}

test('capabilities require one bearer token, prove readiness, and never expose CORS or cacheable responses', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const good = await f.app.inject({ method: 'GET', url: '/v1/capabilities', headers: { ...auth, origin: 'https://foreign.test' } });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json(), { protocol: 'ARCO_STOCKS_SIGNER_V1', profile: 'DEMO_TESTNET', chainId: 91342,
    signerAddress: manifest.signerAddress, noncePolicy: 'DURABLE_SERIALIZED',
    operationPolicy: 'IMMUTABLE_IDEMPOTENT', replacementPolicy: 'DISABLED' });
  assert.equal(good.headers['cache-control'], 'no-store');
  assert.equal(good.headers['access-control-allow-origin'], undefined);
  for (const headers of [{}, { authorization: 'Bearer incorrect' },
    { authorization: ['Bearer ' + token, 'Bearer ' + token] } as unknown as { authorization: string }]) {
    const denied = await f.app.inject({ method: 'GET', url: '/v1/capabilities', headers });
    assert.equal(denied.statusCode, 401);
    assert.deepEqual(denied.json(), { error: 'UNAUTHORIZED' });
    assert.equal(denied.headers['cache-control'], 'no-store');
  }
  assert.equal(f.checks, 1, 'Unauthorized requests must not reach readiness');
  for (const method of ['HEAD', 'POST', 'DELETE', 'OPTIONS'] as const) {
    const response = await f.app.inject({ method, url: '/v1/capabilities', headers: auth });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.throws(() => createStocksSignerHttpService({ manifest, core: createStocksSignerCore({
    manifest, journal: new Journal(), transport: { sendOnce: async () => h(1), findOriginal: async () => null },
  }), bearerToken: 'not-256-bit', ready: async () => true }), /SIGNER_TOKEN_CONFIGURATION_INVALID/);
});

test('PUT and GET preserve exact operation identity, immutable conflict, and a 16 KiB body limit', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const call = authorizedCall(manifest, 'mint:http-valid', 'MINT', a(10), '10');
  const url = `/v1/operations/${call.operationId}`;
  const missing = await f.app.inject({ method: 'GET', url, headers: auth });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: 'SIGNER_OPERATION_UNKNOWN' });
  const first = await f.app.inject({ method: 'PUT', url, headers: auth, payload: request(call) });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { operationId: call.operationId, callDigest: callDigest(call), txHash: h(50) });
  assert.equal(f.sends, 1);
  const again = await f.app.inject({ method: 'PUT', url, headers: auth, payload: request(call) });
  assert.deepEqual(again.json(), first.json());
  assert.equal(f.sends, 1);
  const lookup = await f.app.inject({ method: 'GET', url, headers: auth });
  assert.deepEqual(lookup.json(), first.json());

  const changed = authorizedCall(manifest, call.operationId, 'MINT', a(10), '11');
  const conflict = await f.app.inject({ method: 'PUT', url, headers: auth, payload: request(changed) });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json(), { error: 'SIGNER_IMMUTABLE_OPERATION_CONFLICT' });
  assert.equal(f.sends, 1);
  const oversized = await f.app.inject({ method: 'PUT', url, headers: { ...auth, 'content-type': 'application/json' },
    payload: JSON.stringify({ ...request(call), padding: 'x'.repeat(16 * 1024) }) });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(oversized.json(), { error: 'SIGNER_BODY_TOO_LARGE' });
  assert.equal(f.sends, 1);
  const invalid = await f.app.inject({ method: 'PUT', url, headers: { ...auth, 'content-type': 'application/json' }, payload: '{' });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'SIGNER_REQUEST_INVALID' });
});

test('the existing external signer client accepts the exact v1 capabilities, 404 and submission envelopes', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const requestThroughInject: HttpFetch = async (url, init) => {
    const response = await f.app.inject({ method: init?.method as 'GET' | 'PUT',
      url: new URL(String(url)).pathname,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(response.body, { status: response.statusCode,
      headers: { 'content-type': 'application/json', 'cache-control': String(response.headers['cache-control']) } });
  };
  const client = externalStocksSigner({ url: 'https://signer.example.test/', authorization: token,
    deploymentDigest: digest, manifest, request: requestThroughInject });
  await client.probe();
  assert.equal(await client.lookup('mint:missing'), null);
  const call = authorizedCall(manifest, 'mint:http-client', 'MINT', a(10), '10');
  const result = { operationId: call.operationId, callDigest: callDigest(call), txHash: h(50) };
  assert.deepEqual(await client.submit(call), result);
  assert.deepEqual(await client.lookup(call.operationId), result);
  assert.equal(f.sends, 1);
});

test('ambiguous broadcast remains 503, never retries, and GET only looks up the original', async t => {
  const f = fixture({ send: async () => { throw Error('PRIVATE_CUSTODY_PATH'); } }); t.after(() => f.app.close());
  const call = authorizedCall(manifest, 'mint:http-unknown', 'MINT', a(10), '10');
  const url = `/v1/operations/${call.operationId}`;
  const first = await f.app.inject({ method: 'PUT', url, headers: auth, payload: request(call) });
  assert.equal(first.statusCode, 503);
  assert.deepEqual(first.json(), { error: 'SIGNER_ORIGINAL_OUTCOME_UNKNOWN' });
  assert.doesNotMatch(first.body, /PRIVATE_CUSTODY_PATH/);
  const repeat = await f.app.inject({ method: 'PUT', url, headers: auth, payload: request(call) });
  assert.equal(repeat.statusCode, 503);
  assert.deepEqual(repeat.json(), { error: 'SIGNER_ORIGINAL_OUTCOME_UNKNOWN' });
  assert.equal(f.sends, 1);
  const lookup = await f.app.inject({ method: 'GET', url, headers: auth });
  assert.equal(lookup.statusCode, 404);
  assert.deepEqual(lookup.json(), { error: 'SIGNER_OPERATION_UNKNOWN' });
});

test('readiness failure blocks capabilities, lookup, submit and unknown routes before core work', async t => {
  let unavailable = true;
  const f = fixture({ ready: async () => { if (unavailable) throw Error('PRIVATE_READINESS_REASON'); return false; } });
  t.after(() => f.app.close());
  const call = authorizedCall(manifest, 'mint:http-paused', 'MINT', a(10), '10');
  const cases = [
    { method: 'GET' as const, url: '/v1/capabilities' },
    { method: 'GET' as const, url: `/v1/operations/${call.operationId}` },
    { method: 'PUT' as const, url: `/v1/operations/${call.operationId}`, payload: request(call) },
    { method: 'GET' as const, url: '/health' },
  ];
  for (const input of cases) {
    const response = await f.app.inject({ ...input, headers: auth });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'SIGNER_NOT_READY' });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /PRIVATE_READINESS_REASON/);
  }
  assert.equal(f.sends, 0);
  unavailable = false;
  const stillNotReady = await f.app.inject({ method: 'GET', url: '/v1/capabilities', headers: auth });
  assert.equal(stillNotReady.statusCode, 503);
  const unauthorized = await f.app.inject({ method: 'GET', url: '/v1/capabilities' });
  assert.equal(unauthorized.statusCode, 401, 'Authentication precedes readiness');
});
