import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveOrder, digest as transactionDigest } from '../../server/dist/stocks-submissions/contracts.js';
import { StocksTradingControlService } from '../../server/dist/stocks-trading-control/service.js';

// Only called by the owned, unforked local EVM + fresh PostgreSQL stack.
export async function verifyOperatorControl(f) {
  const { managedApp, pool, manifest, digest, accounts, rpc, waitReceipt, deposit, escrow,
    currentBalance, signer, signerServer, transport } = f;
  const checks = [];
  const options = { operatorControls: true, manualTicks: true };
  const path = 'admin/stocks/trading-control';
  let afterSubmit;
  const runtimeSigner = { probe: () => signer.probe(), lookup: id => signer.lookup(id), submit: async call => {
    try { return await signer.submit(call); }
    finally { const hook = afterSubmit; afterSubmit = undefined; await hook?.(); }
  } };
  const controlled = await managedApp(true, false, transport, { ...options, runtimeSigner });
  const api = controlled.request;
  let version = 0;
  const command = async (paused, reason = 'Local operator control verification') => {
    const body = { paused, expectedVersion: version, idempotencyKey: `local-control-${version}`, reason };
    const result = await api(path, body, 200, 'operator');
    assert.equal(result.state.version, ++version); assert.equal(result.state.paused, paused);
    assert.equal(result.executionAuthorization, false); assert.equal(result.inFlightMayContinue, true);
    return { body, result };
  };
  const tick = () => controlled.runtime.tick();
  const state = async (side, id) => (await api(`stocks/${side === 'BUY' ? 'orders' : 'sell-orders'}/${id}`)).state;
  const complete = async (side, id) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await tick(); if (await state(side, id) === 'COMPLETED') return;
      await delay(150); // Preserve the actual outbox retry deadline after UNKNOWN.
    }
    assert.fail(`Operator control recovery did not complete ${side}: ${await state(side, id)}`);
  };
  const pausedQuotes = async () => {
    for (const suffix of ['quotes', 'sell-quotes']) await api(`stocks/${suffix}`, { symbol: 'NVDA', quantity: '0.125' }, 503);
  };
  try {
    const initial = await api(path, undefined, 200, 'operator');
    assert.equal(initial.state.paused, true); assert.equal(initial.state.version, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::text AS n FROM arco_evm."StocksTradingControl" WHERE "deploymentDigest"=$1', [digest])).rows[0].n, '0');
    assert.deepEqual(controlled.runtime.status().pauseReasons, ['OPERATOR_PAUSE']);
    await pausedQuotes(); await api(path, undefined, 403, 'holder');
    await api(path, { paused: false, expectedVersion: 0, idempotencyKey: 'holder-cannot-control', reason: 'Unauthorized attempt' }, 403, 'holder');
    checks.push('Opt-in starts paused without inserting state; actual SIWE holder cannot control it');
    const resumed = await command(false);
    assert.equal((await api(path, resumed.body, 200, 'operator')).replayed, true);
    await api(path, { ...resumed.body, idempotencyKey: 'stale-control-request' }, 409, 'operator');
    assert.equal((await api(`${path}/history`, undefined, 200, 'operator')).items.length, 1);

    const buyQuote = await api('stocks/quotes', { symbol: 'NVDA', quantity: '0.125' });
    const sellQuote = await api('stocks/sell-quotes', { symbol: 'NVDA', quantity: '0.125' });
    const order = await api('stocks/orders', { quoteId: buyQuote.id, idempotencyKey: 'operator-control-buy' });
    const plan = deriveOrder(manifest, order, 'BUY');
    const claimBody = stage => ({ side: 'BUY', orderId: order.id, intentKey: plan.intentKey, stage,
      transactionDigest: transactionDigest(stage === 'APPROVAL' ? plan.approval : plan.transfer),
      transaction: stage === 'APPROVAL' ? plan.approval : plan.transfer, deploymentDigest: digest });
    const claim = await api('stocks/wallet-submissions/claims', claimBody('APPROVAL'));
    const hash = await rpc('eth_sendTransaction', [{ from: plan.approval.from, to: plan.approval.to,
      data: plan.approval.data, value: '0x0', gas: '0x1e8480' }]);
    await waitReceipt(hash);
    await command(true);
    await pausedQuotes();
    await api('stocks/orders', { quoteId: buyQuote.id, idempotencyKey: 'blocked-control-buy' }, 503);
    await api('stocks/sell-orders', { quoteId: sellQuote.id, idempotencyKey: 'blocked-control-sell' }, 503);
    await api(`stocks/execution/BUY/${order.id}`, undefined, 503);
    await api('stocks/wallet-submissions/claims', claimBody('TRANSFER'), 503);
    // Evidence for an already-authorized real transaction stays recoverable.
    await api('stocks/wallet-submissions/outcomes', { ...claim, status: 'SUBMITTED', txHash: hash });
    const proof = await api('stocks/wallet-submissions/reconcile', { claimId: claim.claimId, intentKey: claim.intentKey,
      stage: claim.stage, transactionDigest: claim.transactionDigest, txHash: hash });
    assert.equal(proof.status, 'CONFIRMED');
    assert.equal((await api(`stocks/wallet-submissions/BUY/${order.id}`)).approval.txHash, hash);
    assert.equal(await state('BUY', order.id), 'AWAITING_FUNDING');
    checks.push('Pause rejects quotes, order creation, execution permission and claims; receipt outcomes/reconcile/inspection continue');

    await command(false);
    await deposit(order);
    await command(true);
    const submittedBefore = signerServer.controls.submissionRequests;
    await tick(); await tick();
    assert.equal(await state('BUY', order.id), 'BROKER_PENDING');
    assert.equal(signerServer.controls.submissionRequests, submittedBefore);
    assert.equal((await pool.query('SELECT status FROM arco_evm."StocksOutbox" WHERE "orderId"=$1 AND kind=\'BROKER\'', [order.id])).rows[0].status, 'PENDING');
    checks.push('Paused observer records actual funding while the broker intent stays PENDING and signer stays idle');

    await command(false);
    signerServer.controls.loseNextBroadcastAcknowledgement = true;
    // Pause via the real authenticated API as the external signer loses its
    // broadcast reply, before the worker attempts original-operation recovery.
    afterSubmit = () => command(true, 'Pause after local signer acknowledgement loss');
    await complete('BUY', order.id);
    assert.equal((await api(path, undefined, 200, 'operator')).state.paused, true);
    assert.equal(signerServer.controls.submissionRequests, submittedBefore + 1);
    assert.equal((await pool.query('SELECT COUNT(*)::text AS n FROM stocks_local_harness.signer_operations WHERE id=$1', [`mint:${order.id}`])).rows[0].n, '1');
    assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '3125000000');
    checks.push('Lost signer response recovers the original operation while paused without a second submit');

    await command(false);
    const quote = await api('stocks/sell-quotes', { symbol: 'NVDA', quantity: '0.125' });
    const sell = await api('stocks/sell-orders', { quoteId: quote.id, idempotencyKey: 'operator-control-sell' });
    await escrow(sell); await command(true); await tick(); await tick();
    assert.equal(await state('SELL', sell.id), 'ESCROW_HELD');
    assert.equal(signerServer.controls.submissionRequests, submittedBefore + 1);
    await command(false); await complete('SELL', sell.id);
    assert.equal(signerServer.controls.submissionRequests, submittedBefore + 2);
    assert.equal(await currentBalance(manifest.stockToken, accounts.holder), '3000000000');
    assert.equal(await currentBalance(manifest.cashToken, manifest.fundingVault), '360000000');
    await command(true);
    checks.push('Paused SELL observes escrow without new settlement; resume settles once and restores cash/stock totals');

    const remote = new StocksTradingControlService(pool, digest);
    const remoteResult = await remote.change({ operatorId: 'local-second-process', permissions: ['stocks:control'] }, {
      paused: false, expectedVersion: version, idempotencyKey: 'other-process-resume', reason: 'Second service instance control verification' });
    version++;
    assert.equal(remoteResult.state.version, version);
    assert.equal(await controlled.runtime.service.paused(), false, 'Admission must read shared DB without a cached pause');
    // A control-store outage must fail closed while chain observation remains
    // functional; diagnostics GET remains synchronous and does not query DB.
    const originalQuery = controlled.pool.query;
    controlled.pool.query = function (sql, ...args) {
      if (typeof sql === 'string' && sql.includes('StocksTradingControl')) return Promise.reject(new Error('LOCAL_CONTROL_STORE_UNAVAILABLE'));
      return originalQuery.call(this, sql, ...args);
    };
    try {
      await pausedQuotes(); await tick();
      const diagnostic = await api('admin/stocks/runtime', undefined, 200, 'operator');
      assert.equal(diagnostic.observerStatus, 'CURRENT');
      assert.deepEqual(diagnostic.pauseReasons, ['OPERATOR_CONTROL_UNAVAILABLE']);
      await api(path, undefined, 503, 'operator');
    } finally { controlled.pool.query = originalQuery; }
    assert.equal(await controlled.runtime.service.paused(), false);
    await command(true);
    checks.push('Another service instance change is visible at next admission; control DB failure blocks new work while observation continues');
  } finally { await controlled.app.close(); }

  const restarted = await managedApp(true, false, transport, options);
  try {
    const snapshot = await restarted.request(path, undefined, 200, 'operator');
    assert.equal(snapshot.state.version, version); assert.equal(snapshot.state.paused, true);
    const history = await restarted.request(`${path}/history`, undefined, 200, 'operator');
    assert.equal(history.items.length, version);
    assert.equal(new Set(history.items.map(item => item.version)).size, version);
  } finally { await restarted.app.close(); }
  checks.push('Runtime restart retains pause, revision and one immutable event per accepted command');

  const remote = new StocksTradingControlService(pool, digest);
  await remote.change({ operatorId: 'local-second-process', permissions: ['stocks:control'] }, {
    paused: false, expectedVersion: version++, idempotencyKey: 'gate-matrix-resume', reason: 'Verify independent runtime gates' });
  for (const [autodispatch, configuredPause, reason] of [[false, false, 'AUTODISPATCH_DISABLED'], [true, true, 'CONFIGURED_PAUSE']]) {
    const blocked = await managedApp(autodispatch, configuredPause, transport, options);
    try {
      assert.equal(blocked.runtime.status().operatorControl.status, 'RESUMED');
      assert.ok(blocked.runtime.status().pauseReasons.includes(reason));
      await blocked.request('stocks/quotes', { symbol: 'NVDA', quantity: '0.125' }, 503);
      blocked.runtime.stop();
      await blocked.request('stocks/sell-quotes', { symbol: 'NVDA', quantity: '0.125' }, 503);
      assert.ok(blocked.runtime.status().pauseReasons.includes('RUNTIME_STOPPED'));
    } finally { await blocked.app.close(); }
  }
  let unavailable = false;
  const transportGate = async (method, params) => { if (unavailable) throw new Error('LOCAL_RPC_UNAVAILABLE'); return transport(method, params); };
  const unhealthy = await managedApp(true, false, transportGate, options);
  try {
    unavailable = true; await unhealthy.runtime.tick();
    assert.equal(unhealthy.runtime.status().operatorControl.status, 'RESUMED');
    assert.ok(unhealthy.runtime.status().pauseReasons.includes('OBSERVER_NOT_CURRENT'));
    await unhealthy.request('stocks/quotes', { symbol: 'NVDA', quantity: '0.125' }, 503);
  } finally { await unhealthy.app.close(); }
  const stopping = await managedApp(true, false, transport, options);
  let releaseRead;
  const blocked = new Promise(resolve => { releaseRead = resolve; });
  let enteredRead;
  const entered = new Promise(resolve => { enteredRead = resolve; });
  const originalQuery = stopping.pool.query;
  stopping.pool.query = async function (sql, ...args) {
    if (typeof sql === 'string' && sql.includes('StocksTradingControl')) { enteredRead(); await blocked; }
    return originalQuery.call(this, sql, ...args);
  };
  try {
    const pendingAdmission = stopping.runtime.service.paused();
    await entered; stopping.runtime.stop(); releaseRead();
    assert.equal(await pendingAdmission, true, 'Stop during the control DB read must still deny admission');
  } finally { releaseRead(); stopping.pool.query = originalQuery; await stopping.app.close(); }
  checks.push('Operator resume cannot override configured pause, disabled dispatch, stopped runtime or unavailable observer');
  return { result: 'PASS', checks, lastVersion: version, additionalSignerOperations: 2 };
}
