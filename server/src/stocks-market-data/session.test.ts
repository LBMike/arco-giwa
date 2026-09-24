import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlpacaMarketClock } from './session.js';

const ID = 'TEST_ONLY_ID', SECRET = 'TEST_ONLY_SECRET';
const openAt = Date.parse('2026-09-24T14:00:00Z');
const closedAt = Date.parse('2026-09-24T23:00:00Z');
const headers = { 'content-type': 'application/json; charset=utf-8' };
const open = {
  timestamp: '2026-09-24T10:00:00.123456789-04:00',
  is_open: true,
  next_open: '2026-09-25T09:30:00-04:00',
  next_close: '2026-09-24T16:00:00-04:00',
};
const closed = {
  timestamp: '2026-09-24T19:00:00-04:00',
  is_open: false,
  next_open: '2026-09-25T09:30:00-04:00',
  next_close: '2026-09-25T16:00:00-04:00',
};
const json = (value: unknown) => new Response(JSON.stringify(value), { headers });

test('reads the official paper trading market clock with server-only credentials', async () => {
  let calls = 0;
  const clock = createAlpacaMarketClock({ keyId: ID, secretKey: SECRET, now: () => openAt, fetch: async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://paper-api.alpaca.markets/v2/clock');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    const sent = new Headers(init?.headers);
    assert.equal(sent.get('APCA-API-KEY-ID'), ID);
    assert.equal(sent.get('APCA-API-SECRET-KEY'), SECRET);
    assert.ok(!String(input).includes(SECRET));
    return json(open);
  } });
  const result = await clock.get();
  assert.deepEqual(result, {
    state: 'OPEN',
    observedAt: '2026-09-24T14:00:00.123Z',
    nextOpen: '2026-09-25T13:30:00.000Z',
    nextClose: '2026-09-24T20:00:00.000Z',
  });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes(ID));
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('reports a validated closed session without predicting a market calendar', async () => {
  const clock = createAlpacaMarketClock({ keyId: ID, secretKey: SECRET, now: () => closedAt, fetch: async () => json(closed) });
  assert.deepEqual(await clock.get(), {
    state: 'CLOSED',
    observedAt: '2026-09-24T23:00:00.000Z',
    nextOpen: '2026-09-25T13:30:00.000Z',
    nextClose: '2026-09-25T20:00:00.000Z',
  });
});

test('singleflights requests, caches for 60 seconds, and does not share mutable results', async () => {
  let now = openAt, calls = 0;
  let release!: (value: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  const clock = createAlpacaMarketClock({ keyId: ID, secretKey: SECRET, now: () => now, fetch: async () => {
    calls++;
    return calls === 1 ? held : json({ ...open, timestamp: new Date(now).toISOString() });
  } });
  const requests = Array.from({ length: 8 }, () => clock.get());
  assert.equal(calls, 1);
  release(json(open));
  const results = await Promise.all(requests);
  assert.ok(results.every(result => result.state === 'OPEN'));
  results[0].state = 'UNKNOWN';
  assert.equal((await clock.get()).state, 'OPEN');
  now += 59_999;
  await clock.get();
  assert.equal(calls, 1);
  now++;
  await clock.get();
  assert.equal(calls, 2);
});

test('the cache expires at a reported session boundary, even before 60 seconds', async () => {
  let now = Date.parse('2026-09-24T19:59:50Z'), calls = 0;
  const clock = createAlpacaMarketClock({ keyId: ID, secretKey: SECRET, now: () => now, fetch: async () => {
    calls++;
    return json(calls === 1 ? { ...open, timestamp: new Date(now).toISOString() } : { ...closed, timestamp: new Date(now).toISOString() });
  } });
  assert.equal((await clock.get()).state, 'OPEN');
  now += 11_000;
  assert.equal((await clock.get()).state, 'CLOSED');
  assert.equal(calls, 2);
});

test('rejects malformed, stale, contradictory, or non-JSON clock responses as UNKNOWN', async () => {
  const invalid: Response[] = [
    json({ ...open, is_open: 'true' }),
    json({ ...open, timestamp: '2026-02-30T10:00:00-04:00' }),
    json({ ...open, timestamp: '2026-09-24T10:00:00' }),
    json({ ...open, timestamp: '2026-09-24T09:00:00-04:00' }),
    json({ ...open, next_close: '2026-09-25T17:00:00-04:00' }),
    new Response('{"timestamp":"x","timestamp":"y"}', { headers }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(8 * 1024 + 1), { headers }),
  ];
  for (const response of invalid) {
    const clock = createAlpacaMarketClock({ keyId: ID, secretKey: SECRET, now: () => openAt, fetch: async () => response });
    assert.deepEqual(await clock.get(), { state: 'UNKNOWN', observedAt: null, nextOpen: null, nextClose: null });
  }
});

test('auth errors, provider failures, network errors and timeouts fail closed to UNKNOWN', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0, now = openAt;
    const clock = createAlpacaMarketClock({ keyId: ID, secretKey: SECRET, now: () => now, fetch: async () => {
      calls++;
      return new Response('provider details may contain secret material', { status });
    } });
    assert.equal((await clock.get()).state, 'UNKNOWN');
    assert.equal((await clock.get()).state, 'UNKNOWN');
    assert.equal(calls, 1);
    now += 60_000;
    assert.equal((await clock.get()).state, 'UNKNOWN');
    assert.equal(calls, 2);
  }
  const failure = createAlpacaMarketClock({ keyId: ID, secretKey: SECRET, fetch: async () => { throw new Error(SECRET); } });
  assert.deepEqual(await failure.get(), { state: 'UNKNOWN', observedAt: null, nextOpen: null, nextClose: null });
  const timeout = createAlpacaMarketClock({ keyId: ID, secretKey: SECRET, timeoutMs: 10, fetch: async () => new Promise<Response>(() => {}) });
  assert.equal((await timeout.get()).state, 'UNKNOWN');
});

test('rejects invalid credentials and timeout settings before sending requests', () => {
  for (const [keyId, secretKey, timeoutMs] of [
    ['', SECRET, 4000], [ID + '\n', SECRET, 4000], [ID, '', 4000], [ID, SECRET, 0], [ID, SECRET, 15_001],
  ] as const) assert.throws(() => createAlpacaMarketClock({ keyId, secretKey, timeoutMs }), /^Error: INVALID_MARKET_CLOCK_CONFIG$/);
});
