import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSessionReport } from './session-report.mjs';

function fixture() {
  return {
    config: { ownerWorkspace: true, capability: 'DO_NOT_EXPORT', accounts: { holder: `0x${'1'.repeat(40)}`, otherHolder: 'DO_NOT_EXPORT' },
      manifest: { profile: 'DEMO_TESTNET', chainId: 91342, cashScale: 6, quantityScale: 9, cashSymbol: 'ARCO_TEST_USDC', deploymentId: 'stocks-local-test', signerToken: 'DO_NOT_EXPORT' } },
    state: { account: 'SELECTED_OPERATOR_IS_NOT_THE_REPORT_OWNER', signature: 'DO_NOT_EXPORT', snapshot: {
      blockNumber: '12', blockHash: `0x${'2'.repeat(64)}`, holderCash: '1820000000', holderStock: '1500000000', vaultCash: '180000000', escrowStock: '0', stockSupply: '1500000000',
      buyOrders: [{ id: 'buy-1', state: 'COMPLETED', token: 'DO_NOT_EXPORT' }], sellOrders: [{ id: 'sell-1', state: 'COMPLETED' }],
      reconciliationStatus: 'MATCHED_AT_CUTOFF', requests: ['DO_NOT_EXPORT'], signer: { privateKey: 'DO_NOT_EXPORT' },
    } },
  };
}

test('summary exports a fresh allowlist, fixed Account A scope and exact balances without credentials or raw diagnostics', () => {
  const f = fixture(), before = structuredClone(f), at = new Date('2026-09-20T00:00:00.000Z');
  const report = createLocalSessionReport(f.config, f.state, at);
  assert.deepEqual(report.balances, { holderCash: '1820', holderStock: '1.5', vaultCash: '180', escrowStock: '0', stockSupply: '1.5' });
  assert.equal(report.capturedAt, at.toISOString()); assert.equal(report.coverage.account, 'A');
  assert.equal(report.holder, f.config.accounts.holder); assert.equal(report.restorableBackup, false);
  assert.equal(report.coverage.atomicSnapshot, false); assert.equal(report.coverage.fullHistory, false);
  assert.deepEqual(report.orders.buy, [{ id: 'buy-1', state: 'COMPLETED' }]);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_EXPORT|SELECTED_OPERATOR/);
  assert.deepEqual(f, before);
  f.state.snapshot.buyOrders[0].state = 'CHANGED';
  assert.equal(report.orders.buy[0].state, 'COMPLETED');
});

test('summary preserves smallest units and values beyond JavaScript safe integer range', () => {
  const f = fixture(); f.state.snapshot.holderCash = '9007199254740993'; f.state.snapshot.holderStock = '1';
  const report = createLocalSessionReport(f.config, f.state);
  assert.equal(report.balances.holderCash, '9007199254.740993');
  assert.equal(report.balances.holderStock, '0.000000001');
  assert.equal(report.baseUnits.holderCash, '9007199254740993');
});

test('summary labels bounded order coverage and rejects malformed data rather than exporting partial or invented balances', () => {
  const f = fixture();
  f.state.snapshot.buyOrders = Array.from({ length: 100 }, (_, i) => ({ id: `order-${i}`, state: 'AWAITING_FUNDING' }));
  assert.equal(createLocalSessionReport(f.config, f.state).orders.buy.length, 100);
  assert.equal(createLocalSessionReport(f.config, f.state).coverage.latestOrdersPerSide, 100);
  for (const mutate of [
    f => { f.config.ownerWorkspace = false; }, f => { f.config.manifest.chainId = 1; },
    f => { f.config.manifest.cashScale = 18; }, f => { f.config.manifest.cashSymbol = 'USDC'; },
    f => { f.state.snapshot.holderCash = '1.2'; }, f => { delete f.state.snapshot.holderStock; },
    f => { f.state.snapshot.vaultCash = '-1'; }, f => { f.state.snapshot.escrowStock = 0; },
    f => { f.state.snapshot.blockHash = 'bad'; }, f => { f.state.snapshot.buyOrders = new Array(1); },
    f => { f.state.snapshot.buyOrders.push({ ...f.state.snapshot.buyOrders[0] }); },
    f => { f.state.snapshot.buyOrders = new Array(101).fill({ id: 'order', state: 'COMPLETED' }); },
    f => { f.state.snapshot.sellOrders[0].state = '<script>'; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => createLocalSessionReport(f.config, f.state), /LOCAL_SESSION_REPORT_INVALID/); }
  assert.throws(() => createLocalSessionReport(f.config, f.state, new Date(NaN)), /LOCAL_SESSION_REPORT_INVALID/);
});
