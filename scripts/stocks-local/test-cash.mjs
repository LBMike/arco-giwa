import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Local fixture only. The composition fixes the holder, cash token and faucet;
// callers cannot choose a recipient or amount. Ambiguous sends are not retried.
export function createTestCashTopUp({ balance, send, receipt, closed }) {
  const target = 2000000000n; // 2,000 ARCO_TEST_USDC (6 decimals)
  let current, uncertain = false;
  return {
    topUp() {
      assert.ok(!closed(), 'LOCAL_TEST_CASH_CLOSED');
      if (current) return current;
      assert.ok(!uncertain, 'LOCAL_TEST_CASH_REVIEW_REQUIRED');
      return current = (async () => {
        const value = await balance();
        assert.match(value, /^(0|[1-9][0-9]*)$/);
        assert.ok(!closed(), 'LOCAL_TEST_CASH_CLOSED');
        const amount = target - BigInt(value);
        if (amount <= 0n) return;
        uncertain = true;
        const hash = await send(amount);
        assert.match(hash, /^0x[0-9a-f]{64}$/);
        for (let attempt = 0; attempt < 100; attempt++) {
          assert.ok(!closed(), 'LOCAL_TEST_CASH_CLOSED');
          const found = await receipt(hash);
          if (found) {
            assert.equal(found.transactionHash, hash);
            assert.equal(found.status, '0x1', 'LOCAL_TEST_CASH_REJECTED');
            uncertain = false;
            return;
          }
          await delay(50);
        }
        throw Error('LOCAL_TEST_CASH_REVIEW_REQUIRED');
      })().finally(() => { current = undefined; });
    },
    async drain() { await current?.catch(() => {}); },
  };
}
