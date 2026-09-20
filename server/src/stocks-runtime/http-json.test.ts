import test from 'node:test';
import assert from 'node:assert/strict';
import { stocksHttpJson } from './http-json.js';

const target = new URL('https://provider.example.test/private-path');
const options = { maxBytes: 64, errorCode: 'STOCKS_RPC_UNAVAILABLE' as const };
const rejected = /^Error: STOCKS_RPC_UNAVAILABLE$/;

test('bounded reader accepts the exact UTF-8 byte limit, including split multibyte characters', async () => {
  const bytes = new TextEncoder().encode('{"name":"한글"}');
  const result = await stocksHttpJson(target, {}, { ...options, maxBytes: bytes.length, request: async () =>
    new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } })) });
  assert.deepEqual(result, { name: '한글' });
});

test('declared excess, dishonest streamed excess and non-numeric lengths cancel their response', async () => {
  for (const length of ['65', '1', '-1', '9999999999999999999999999999999999999']) {
    let cancelled = false;
    await assert.rejects(stocksHttpJson(target, {}, { ...options, request: async () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65)); }, cancel() { cancelled = true; } }),
        { headers: { 'content-length': length } }) }), rejected);
    assert.equal(cancelled, true);
  }
});

test('HTTP error and absent operation cancel unread bodies; only explicitly enabled 404 returns null', async () => {
  for (const [status, allowNotFound] of [[503, true], [404, false], [404, true]] as const) {
    let cancelled = false;
    const work = stocksHttpJson(target, {}, { ...options, allowNotFound, request: async () => new Response(
      new ReadableStream({ cancel() { cancelled = true; } }), { status }) });
    if (status === 404 && allowNotFound) assert.equal(await work, null);
    else await assert.rejects(work, rejected);
    assert.equal(cancelled, true);
  }
});

test('deadline rejects a fetch that ignores abort; a late response is cancelled and never decoded', { timeout: 3000 }, async () => {
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | undefined, requests = 0, cancelled = false;
  const work = stocksHttpJson(target, {}, { ...options, timeoutMs: 20, request: async (_target, init) => {
    requests++; signal = init?.signal ?? undefined;
    return new Promise<Response>(yes => { resolve = yes; });
  } });
  await assert.rejects(work, rejected);
  assert.equal(signal?.aborted, true); assert.equal(requests, 1);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(yes => setImmediate(yes));
  assert.equal(cancelled, true);
});

test('the deadline includes a stalled body and does not wait for a stuck cancellation callback', { timeout: 3000 }, async () => {
  let cancelled = false, signal: AbortSignal | undefined;
  await assert.rejects(stocksHttpJson(target, {}, { ...options, timeoutMs: 20, request: async (_target, init) => {
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; return new Promise(() => {}); } }));
  } }), rejected);
  assert.equal(cancelled, true); assert.equal(signal?.aborted, true);
});

test('late success, clock reversal and invalid clock fail even before the timer callback runs', async () => {
  for (const late of [20, -1, NaN, Infinity]) {
    let now = 0, cancelled = false;
    await assert.rejects(stocksHttpJson(target, {}, { ...options, timeoutMs: 20, now: () => now, request: async () => {
      now = late;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{}')); }, cancel() { cancelled = true; } }));
    } }), rejected);
    assert.equal(cancelled, true);
  }
});

test('header time is not reset for the body; slow chunks do not extend the original deadline', async () => {
  let now = 0, pulls = 0;
  await assert.rejects(stocksHttpJson(target, {}, { ...options, timeoutMs: 20, now: () => now, request: async () => {
    now = 15;
    return new Response(new ReadableStream({ pull(c) {
      pulls++; now += 3; c.enqueue(new TextEncoder().encode(' '));
    } }, { highWaterMark: 0 }));
  } }), rejected);
  assert.equal(pulls, 2);
});

test('redirected or foreign responses cannot bypass the error-on-redirect request policy', async () => {
  for (const metadata of [{ redirected: true }, { url: 'https://foreign.example.test' }]) {
    let cancelled = false;
    await assert.rejects(stocksHttpJson(target, {}, { ...options, request: async (_target, init) => {
      assert.equal(init?.redirect, 'error');
      const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      for (const [key, value] of Object.entries(metadata)) Object.defineProperty(response, key, { value });
      return response;
    } }), rejected);
    assert.equal(cancelled, true);
  }
});

test('bad budgets fail before any request and errors contain no raw cause or response', async () => {
  for (const extra of [{ maxBytes: 0 }, { maxBytes: Infinity }, { timeoutMs: 0 }, { timeoutMs: 10001 }]) {
    let calls = 0;
    await assert.rejects(stocksHttpJson(target, {}, { ...options, ...extra, request: async () => { calls++; return Response.json({}); } }), rejected);
    assert.equal(calls, 0);
  }
  await assert.rejects(stocksHttpJson(target, {}, { ...options, request: async () => { throw Error('PRIVATE_BODY_TOKEN'); } }), error =>
    error instanceof Error && error.message === 'STOCKS_RPC_UNAVAILABLE' && !('cause' in error));
});
