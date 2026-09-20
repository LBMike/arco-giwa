import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestCashTopUp } from './test-cash.mjs';

const hash = `0x${'1'.repeat(64)}`;
const success = { transactionHash: hash, status: '0x1' };

test('top-up mints only the deficit; concurrent requests share one send and funded accounts do not send', async () => {
  let cash = '1820000000', release, arrived;
  const waiting = new Promise(resolve => { arrived = resolve; });
  const sends = [];
  const faucet = createTestCashTopUp({ closed: () => false, balance: async () => cash,
    send: async amount => { sends.push(amount); return hash; },
    receipt: async () => { arrived(); await new Promise(resolve => { release = resolve; }); cash = '2000000000'; return success; } });
  const first = faucet.topUp(), second = faucet.topUp();
  assert.equal(first, second);
  await waiting; assert.deepEqual(sends, [180000000n]);
  release(); await Promise.all([first, second]);
  await faucet.topUp(); cash = '3000000000'; await faucet.topUp();
  assert.equal(sends.length, 1);
});

test('ambiguous sends or invalid receipts block further sends in this workspace', async () => {
  for (const fault of ['lost-response', 'reverted', 'different-transaction']) {
    let sends = 0;
    const faucet = createTestCashTopUp({ closed: () => false, balance: async () => '0',
      send: async () => { sends++; if (fault === 'lost-response') throw Error('RESPONSE_LOST'); return hash; },
      receipt: async () => fault === 'reverted' ? { ...success, status: '0x0' } : { ...success, transactionHash: `0x${'2'.repeat(64)}` } });
    await assert.rejects(faucet.topUp());
    assert.throws(() => faucet.topUp(), /LOCAL_TEST_CASH_REVIEW_REQUIRED/);
    await faucet.drain(); assert.equal(sends, 1);
  }
});

test('read failures can retry before any send; shutdown blocks admission and drains accepted work', async () => {
  let stopped = false, failure = true, sends = 0;
  const faucet = createTestCashTopUp({ closed: () => stopped,
    balance: async () => { if (failure) throw Error('BALANCE_UNAVAILABLE'); stopped = true; return '0'; },
    send: async () => { sends++; return hash; }, receipt: async () => success });
  await assert.rejects(faucet.topUp(), /BALANCE_UNAVAILABLE/);
  failure = false; await assert.rejects(faucet.topUp(), /LOCAL_TEST_CASH_CLOSED/);
  assert.throws(() => faucet.topUp(), /LOCAL_TEST_CASH_CLOSED/);
  await faucet.drain(); assert.equal(sends, 0);

  let release, arrived, drained = false;
  const waiting = new Promise(resolve => { arrived = resolve; });
  const accepted = createTestCashTopUp({ closed: () => false, balance: async () => '0', send: async () => hash,
    receipt: async () => { arrived(); await new Promise(resolve => { release = resolve; }); return success; } });
  const work = accepted.topUp(); await waiting;
  const closing = accepted.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release(); await work; await closing; assert.equal(drained, true);
});
