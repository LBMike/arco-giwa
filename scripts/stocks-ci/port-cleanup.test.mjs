import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { assertPortClosed } from '../stocks-local/assert-port-closed.mjs';

const base = 'http://127.0.0.1:43219';
function probe(event, value, { throwOnConnect = false } = {}) {
  const socket = new EventEmitter();
  let destroyed = 0;
  socket.destroy = () => { destroyed++; socket.emit('close'); };
  const options = { timeoutMs: 20, connectSocket: target => {
    assert.deepEqual(target, { host: '127.0.0.1', port: 43219 });
    if (throwOnConnect) throw new Error('simulated connect failure');
    if (event) queueMicrotask(() => socket.emit(event, value));
    return socket;
  } };
  return { options, destroyed: () => destroyed };
}

test('cleanup accepts explicit connection refusal and destroys the probe exactly once', async () => {
  const fixture = probe('error', { code: 'ECONNREFUSED' });
  await assertPortClosed(base, fixture.options);
  assert.equal(fixture.destroyed(), 1);
});

for (const code of ['EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', undefined])
  test(`cleanup rejects inconclusive socket error ${code}`, async () => {
    const fixture = probe('error', { code });
    await assert.rejects(assertPortClosed(base, fixture.options), /probe failed/);
    assert.equal(fixture.destroyed(), 1);
  });

test('a silent probe times out as failure and releases its socket', async () => {
  const fixture = probe();
  await assert.rejects(assertPortClosed(base, fixture.options), /timed out/);
  assert.equal(fixture.destroyed(), 1);
});

test('a socket closing without a refusal is not evidence of cleanup', async () => {
  const fixture = probe('close');
  await assert.rejects(assertPortClosed(base, fixture.options), /closed without a result/);
  assert.equal(fixture.destroyed(), 1);
});

test('a successful connection means the owned port is still open', async () => {
  const fixture = probe('connect');
  await assert.rejects(assertPortClosed(base, fixture.options), /still listening/);
  assert.equal(fixture.destroyed(), 1);
});

test('synchronous connection failure cannot become cleanup success', async () => {
  const fixture = probe(undefined, undefined, { throwOnConnect: true });
  await assert.rejects(assertPortClosed(base, fixture.options), /could not start/);
});

test('untrusted endpoint and timeout inputs are rejected before any connection', async () => {
  let calls = 0;
  const options = { connectSocket: () => { calls++; throw new Error('unexpected'); } };
  for (const value of ['https://127.0.0.1:43219', 'http://localhost:43219', 'http://example.com:43219',
    'http://[::1]:43219', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://user:pass@127.0.0.1:43219', 'invalid']) await assert.rejects(assertPortClosed(value, options));
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5])
    await assert.rejects(assertPortClosed(base, { ...options, timeoutMs }));
  assert.equal(calls, 0);
});

test('real owned loopback listener fails while open and passes only after shutdown', async () => {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try { await assert.rejects(assertPortClosed(endpoint), /still listening/); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  await assertPortClosed(endpoint);
});
