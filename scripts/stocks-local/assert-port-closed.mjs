import assert from 'node:assert/strict';
import { connect } from 'node:net';

// A failed probe is not evidence of cleanup. Only an explicit refusal on the
// owned loopback endpoint establishes that it is no longer accepting connections.
export async function assertPortClosed(base, { connectSocket = connect, timeoutMs = 1000 } = {}) {
  const url = new URL(base);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, ''); assert.equal(url.password, '');
  const port = Number(url.port);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'Owned port required');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Bounded probe timeout required');
  await new Promise((resolve, reject) => {
    let socket, timer, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error); else resolve();
    };
    timer = setTimeout(() => finish(new Error('Owned port cleanup probe timed out')), timeoutMs);
    try {
      socket = connectSocket({ host: '127.0.0.1', port });
      socket.once('connect', () => finish(new Error('An owned verification port is still listening')));
      socket.once('error', error => finish(error.code === 'ECONNREFUSED'
        ? undefined : new Error('Owned port cleanup probe failed')));
      socket.once('close', () => finish(new Error('Owned port cleanup probe closed without a result')));
    } catch {
      finish(new Error('Owned port cleanup probe could not start'));
    }
  });
}
