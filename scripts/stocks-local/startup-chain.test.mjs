import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalStartupChain } from './startup-chain.mjs';

for (const code of ['UND_ERR_SOCKET', 'ECONNRESET'])
  test(`startup permits one fresh read after ${code}, never any signing or send`, async () => {
    const calls = [];
    await assertLocalStartupChain(async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new TypeError('fetch failed', { cause: { code } });
      return '0x164ce';
    });
    assert.deepEqual(calls, [['eth_chainId', []], ['eth_chainId', []]]);
  });

test('a second disconnect fails startup; retries are not open ended', async () => {
  let calls = 0;
  await assert.rejects(assertLocalStartupChain(async () => {
    calls++; throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
  }), TypeError);
  assert.equal(calls, 2);
});

test('wrong chain, timeout, refused connection and logical failures never trigger retries', async () => {
  for (const value of ['0x1', new DOMException('timeout', 'TimeoutError'),
    new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }), new Error('RPC rejected')]) {
    let calls = 0;
    await assert.rejects(assertLocalStartupChain(async () => { calls++; if (value instanceof Error) throw value; return value; }));
    assert.equal(calls, 1);
  }
});

test('a successful first read makes no second request', async () => {
  let calls = 0; await assertLocalStartupChain(async () => { calls++; return '0x164ce'; }); assert.equal(calls, 1);
});
