import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkStocksConnection } from './connection.js';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { runtimeSnapshot } from '../stocks-runtime/status.js';
import { StocksObservationHealth } from '../stocks-runtime/health.js';

const api = 'https://api.example.test', frontend = 'https://ui.example.test:444';
function fixture(enabled = true) {
  const health = new StocksObservationHealth();
  const env: AppEnv = { corsAllowedOrigins: [frontend], authNonceTtlSeconds: 60, authJwtSecret: 'TEST_ONLY_CONNECTION', adminOperatorToken: 'TEST_ONLY_OPERATOR', registryPath: '/NO_REGISTRY' };
  const base = { arco: {}, registry: {}, portfolio: {}, readiness: {} } as unknown as ArcoAppServices;
  const app = buildApp(env, { ...base, stocksRuntimeStatus: enabled ? {
    getSnapshot: () => runtimeSnapshot({ deploymentId: 'fixture-deployment', deploymentDigest: 'a'.repeat(64),
      autodispatch: true, configuredPause: true, stopped: false, tickInFlight: false, health: health.snapshot() }),
  } : undefined });
  const calls: { url: string; method: string }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, api); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.body, undefined);
    const headers = Object.fromEntries(new Headers(init?.headers));
    assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined);
    const method = init?.method as 'GET' | 'OPTIONS';
    assert.ok(['GET', 'OPTIONS'].includes(method)); calls.push({ url: url.href, method });
    const response = await app.inject({ method, url: url.pathname, headers });
    const publicHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) publicHeaders.set(key, String(value));
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: publicHeaders });
  };
  return { app, health, calls, request };
}
test('actual app passes explicit-origin connection checks without credentials or mutations, even while configured paused', async t => {
  const f = fixture(); t.after(() => f.app.close()); f.health.record('CURRENT');
  const result = await checkStocksConnection(api, frontend, { request: f.request });
  assert.deepEqual(result, { status: 'CONNECTION_CHECKS_PASSED', tradingAuthorized: false,
    checks: { apiLiveness: 'PASS', stocksReadiness: 'PASS', browserCors: 'PASS', operatorAuthentication: 'PASS' } });
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname).sort(),
    ['/health', '/ready/stocks', ...Array(3).fill('/api/v1/admin/stocks/runtime')].sort());
});
test('connected startup is NOT_READY, while missing Stocks routes or wrong browser origin are BLOCKED', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const starting = await checkStocksConnection(api, frontend, { request: f.request });
  assert.equal(starting.status, 'NOT_READY'); assert.equal(starting.checks.stocksReadiness, 'NOT_READY');
  const wrongOrigin = await checkStocksConnection(api, 'https://wrong.example.test', { request: f.request });
  assert.equal(wrongOrigin.status, 'BLOCKED'); assert.equal(wrongOrigin.checks.browserCors, 'FAIL');
  const disabled = fixture(false); t.after(() => disabled.app.close());
  const missing = await checkStocksConnection(api, frontend, { request: disabled.request });
  assert.equal(missing.status, 'BLOCKED'); assert.equal(missing.checks.stocksReadiness, 'FAIL');
});
test('invalid or credential-bearing settings cause zero requests and never escape into reports', async () => {
  let calls = 0;
  for (const value of ['http://api.test', 'https://user:PRIVATE@api.test', 'https://api.test?PRIVATE', 'https://api.test/#PRIVATE',
    'https://api.test/path', 'https://api.test,evil.test', 'https://*.test', 'https://api.test\\path', ' https://api.test', null]) {
    for (const values of [[value, frontend], [api, value]]) {
      const result = await checkStocksConnection(values[0], values[1], { request: (async () => { calls++; throw Error('PRIVATE'); }) as typeof fetch });
      assert.equal(result.status, 'BLOCKED'); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    }
  }
  assert.equal(calls, 0);
});
test('wrong API identity stops further probes; errors, redirects, oversized and malformed JSON fail closed', async () => {
  for (const make of [
    () => new Response('{"ok":true,"service":"other"}'),
    () => new Response('{"ok":true,"service":"arco-giwa-api","private":"PRIVATE"}'),
    () => new Response('x'.repeat(4097)), () => new Response('{invalid'),
    () => { throw Error('PRIVATE_TOKEN'); },
    () => Object.defineProperty(new Response('{}'), 'redirected', { value: true }),
  ]) {
    let calls = 0;
    const result = await checkStocksConnection(api, frontend, { request: (async () => { calls++; return make(); }) as typeof fetch });
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.checks.apiLiveness, 'FAIL');
    assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('widened CORS, broken preflight, cached readiness, mismatched readiness and anonymous admin success cannot pass', async t => {
  const f = fixture(); t.after(() => f.app.close()); f.health.record('CURRENT');
  for (const mutation of ['wildcard', 'negative-origin', 'missing-header', 'actual-get', 'cache', 'ready-body', 'ready-status', 'anonymous']) {
    const request: typeof fetch = async (url, init) => {
      const response = await f.request(url, init), path = new URL(String(url)).pathname;
      if (mutation === 'wildcard') response.headers.set('access-control-allow-origin', '*');
      if (mutation === 'negative-origin' && new Headers(init?.headers).get('origin')?.endsWith('.invalid')) response.headers.set('access-control-allow-origin', 'https://stocks-connection-probe.invalid');
      if (mutation === 'missing-header' && init?.method === 'OPTIONS') response.headers.set('access-control-allow-headers', 'content-type');
      if (mutation === 'actual-get' && path === '/ready/stocks') response.headers.delete('access-control-allow-origin');
      if (mutation === 'cache' && path === '/ready/stocks') response.headers.set('cache-control', 'public');
      if (mutation === 'ready-body' && path === '/ready/stocks') return new Response(JSON.stringify({ ok: true, service: 'arco-giwa-stocks', executionAuthorization: true }), { headers: response.headers });
      if (mutation === 'ready-status' && path === '/ready/stocks') return new Response(response.body, { status: 503, headers: response.headers });
      if (mutation === 'anonymous' && init?.method === 'GET' && path === '/api/v1/admin/stocks/runtime') return new Response('{}', { headers: response.headers });
      return response;
    };
    const result = await checkStocksConnection(api, frontend, { request });
    assert.equal(result.status, 'BLOCKED', mutation); assert.equal(result.tradingAuthorized, false);
  }
});
test('stalled headers and body have a bounded deadline and are cancelled', async () => {
  let signal: AbortSignal | undefined, cancelled = false;
  for (const body of [false, true]) {
    const result = await checkStocksConnection(api, frontend, { timeoutMs: 20, request: (async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return body ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : new Promise(() => {});
    }) as typeof fetch });
    assert.equal(result.status, 'BLOCKED'); assert.equal(signal?.aborted, true);
  }
  assert.equal(cancelled, true);
});
test('connection CLI help and invalid inputs use fixed output without network or dotenv', () => {
  const script = 'scripts/stocks-preflight/check-connection.mjs';
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /Read-only public GET\/OPTIONS/);
  for (const args of [[], ['--token', 'PRIVATE'], ['--api', 'https://user:PRIVATE@api.test', '--origin', frontend]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).status, 'BLOCKED');
    assert.ok(!result.stdout.includes('PRIVATE')); assert.equal(result.stderr, '');
  }
});
