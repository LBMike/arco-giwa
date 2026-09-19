// LOCAL TEST ONLY. Invoke after the original browser trading scenario and its
// claim-before-send evidence have passed. Fixture transactions are not UI sends.
// Normal orders/claims use the production services; terminal proofs are verified
// against actual mined local EVM receipts. No business completion is fabricated.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationKey } from '../../server/dist/stocks/contracts.js';
import { deriveOrder, digest } from '../../server/dist/stocks-submissions/contracts.js';
import { createSubmissionReceiptVerifier } from '../../server/dist/stocks-submissions/receipts.js';
import { StocksSubmissionsService } from '../../server/dist/stocks-submissions/service.js';
import { StocksSubmissionDiagnosticsService } from '../../server/dist/stocks-submission-diagnostics/service.js';

const binding = claim => ({ claimId: claim.claimId, intentKey: claim.intentKey,
  stage: claim.stage, transactionDigest: claim.transactionDigest });

/** The caller owns the only local database/EVM and must leave processing stopped
 * throughout its diagnostics read-only assertions. No service is started here. */
export async function prepareOperatorDiagnosticsFixtures(stack) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  assert.equal(new URL(stack.apiBase).hostname, '127.0.0.1');
  assert.equal(await stack.rpc('eth_chainId'), '0x164ce');
  const metadata = await stack.rpc('hardhat_metadata');
  assert.ok(metadata.instanceId && !metadata.forkedNetwork);
  await stack.stopProcessing();
  const actor = { actorId: `evm:${stack.accounts.holder}`, wallet: stack.accounts.holder,
    verified: true, chainId: 91342, scope: 'STOCKS_TESTNET' };
  const journal = new StocksSubmissionsService(stack.service, createSubmissionReceiptVerifier(stack.manifest, stack.chain));
  const diagnostics = new StocksSubmissionDiagnosticsService(stack.service);
  const cases = [], foreignOrders = [], fixtureSends = [];

  async function capture(name, side, orderId, provenance) {
    const snapshot = await diagnostics.inspect(side, orderId);
    cases.push({ name, side, orderId, provenance, expected: snapshot.data });
    return snapshot.data;
  }
  async function order(side) {
    const service = side === 'BUY' ? stack.service : stack.service.sell;
    const quote = await service.quote(actor, 'NVDA', '0.001');
    return service.createOrder(actor, quote.id, `diagnostics:${randomUUID()}`);
  }
  function request(row, side, stage) {
    const plan = deriveOrder(stack.manifest, row, side);
    const transaction = stage === 'APPROVAL' ? plan.approval : plan.transfer;
    return { side, orderId: row.id, intentKey: plan.intentKey, stage,
      transactionDigest: digest(transaction), transaction, deploymentDigest: stack.digest };
  }
  async function send(transaction, revert) {
    const nonce = await stack.rpc('eth_getTransactionCount', [transaction.from, 'pending']);
    // 23,000 gas covers this call's intrinsic gas but cannot execute its storage
    // writes. The resulting failed execution is a REAL mined receipt, not a
    // substituted status or mocked receipt. Hardhat may reject its RPC response.
    const gas = revert ? '0x59d8' : '0x1e8480';
    let txHash, rejectedAcknowledgment = false;
    try {
      txHash = await stack.rpc('eth_sendTransaction', [{ from: transaction.from, to: transaction.to,
        data: transaction.data, value: '0x0', gas, nonce }]);
    } catch (error) {
      if (!revert || error?.message !== 'LOCAL_UI_RPC_REJECTED') throw error;
      rejectedAcknowledgment = true;
      const block = await stack.rpc('eth_getBlockByNumber', ['latest', true]);
      const matches = block.transactions.filter(tx => tx.from.toLowerCase() === transaction.from.toLowerCase()
        && BigInt(tx.nonce) === BigInt(nonce) && tx.to.toLowerCase() === transaction.to.toLowerCase()
        && tx.input === transaction.data && BigInt(tx.value) === 0n);
      assert.equal(matches.length, 1, 'Original failed fixture transaction must actually have mined');
      txHash = matches[0].hash;
    }
    const receipt = await stack.rpc('eth_getTransactionReceipt', [txHash]);
    assert.equal(receipt?.status, revert ? '0x0' : '0x1');
    const actual = await stack.rpc('eth_getTransactionByHash', [txHash]);
    assert.equal(actual.input, transaction.data);
    assert.equal(BigInt(actual.nonce), BigInt(nonce));
    fixtureSends.push({ txHash, nonce, gas, receiptStatus: receipt.status,
      blockNumber: receipt.blockNumber, rejectedAcknowledgment });
    return txHash;
  }

  // Capture genuine completed orders from the original product-button scenario.
  // Some transfer hashes remain SUBMITTED after the observer completes the order;
  // verify those original hashes before demonstrating trusted terminal summaries.
  const baseline = await stack.snapshot();
  for (const side of ['BUY', 'SELL']) {
    const rows = side === 'BUY' ? baseline.buyOrders : baseline.sellOrders;
    const completed = rows.find(row => row.state === 'COMPLETED'
      && ['APPROVAL', 'TRANSFER'].every(stage => baseline.claims.some(claim => claim.orderId === row.id
        && claim.stage === stage && claim.txHash)));
    assert.ok(completed, `Original browser scenario must provide a genuinely completed ${side}`);
    for (const claim of baseline.claims.filter(row => row.orderId === completed.id)) {
      assert.equal((await journal.reconcile(actor, { ...binding(claim), txHash: claim.txHash })).status, 'CONFIRMED');
    }
    const expected = await capture(`${side}: completed with two verified receipts`, side, completed.id, 'ORIGINAL_BROWSER_ORDER_REAL_EVM');
    assert.equal(expected.approval?.receipt?.status, 'CONFIRMED');
    assert.equal(expected.transfer?.receipt?.status, 'CONFIRMED');
  }

  const sources = new Map();
  for (const side of ['BUY', 'SELL']) {
    const untouched = await order(side); sources.set(side, untouched);
    const empty = await capture(`${side}: enrolled with no attempts`, side, untouched.id, 'PRODUCTION_SERVICE');
    assert.equal(empty.enrollment, 'ENROLLED');
    assert.equal(empty.approval, null); assert.equal(empty.transfer, null);

    for (const stage of ['APPROVAL', 'TRANSFER']) {
      for (const status of ['REQUEST_MAY_START', 'UNKNOWN', 'SUBMITTED', 'REVERTED']) {
        const row = await order(side), input = request(row, side, stage);
        const claim = await journal.claim(actor, input); assert.ok(claim);
        if (status === 'UNKNOWN') await journal.record(actor, { ...binding(claim), status });
        if (status === 'SUBMITTED' || status === 'REVERTED') {
          // A submitted transfer deliberately has a real failed mined receipt
          // which has not yet been verified. Its journal truth is SUBMITTED;
          // receipt existence alone must not fabricate a terminal UI status.
          const txHash = await send(input.transaction, status === 'REVERTED' || stage === 'TRANSFER');
          await journal.record(actor, { ...binding(claim), status: 'SUBMITTED', txHash });
          if (status === 'REVERTED') assert.equal((await journal.reconcile(actor, { ...binding(claim), txHash })).status, status);
        }
        const expected = await capture(`${side} ${stage}: ${status}`, side, row.id,
          status === 'REVERTED' || status === 'SUBMITTED' ? 'PRODUCTION_SERVICE_REAL_EVM' : 'PRODUCTION_SERVICE');
        const attempt = expected[stage === 'APPROVAL' ? 'approval' : 'transfer'];
        assert.equal(attempt?.status, status);
        assert.equal(attempt?.receipt?.status ?? null, status === 'REVERTED' ? status : null);
        if (status === 'REQUEST_MAY_START' || status === 'UNKNOWN') assert.equal(attempt.txHash, null);
        assert.equal(expected.order.state, side === 'BUY' ? 'AWAITING_FUNDING' : 'AWAITING_ESCROW');
      }
    }
    const row = await order(side), input = request(row, side, 'APPROVAL');
    const claim = await journal.claim(actor, input); assert.ok(claim);
    const txHash = await send(input.transaction, false);
    await journal.record(actor, { ...binding(claim), status: 'SUBMITTED', txHash });
    await journal.reconcile(actor, { ...binding(claim), txHash });
    const expected = await capture(`${side}: confirmed approval is not business completion`, side, row.id, 'PRODUCTION_SERVICE_REAL_EVM');
    assert.equal(expected.approval?.receipt?.status, 'CONFIRMED'); assert.equal(expected.transfer, null);
    assert.equal(expected.order.state, side === 'BUY' ? 'AWAITING_FUNDING' : 'AWAITING_ESCROW');
  }

  // Explicit historical/foreign fixtures only: new isolated rows, never removal
  // of immutable enrollment, mutation of a live quote, or fabricated completion.
  // They model orders created before enrollment and a different deployment.
  async function insertedFixture(side, foreign) {
    const source = sources.get(side), id = randomUUID(), quoteId = randomUUID();
    const quoteTable = side === 'BUY' ? 'StocksQuote' : 'StocksSellQuote';
    const orderTable = side === 'BUY' ? 'StocksOrder' : 'StocksSellOrder';
    const deploymentDigest = foreign ? digest(['EXPLICIT_FOREIGN_DEPLOYMENT_FIXTURE', randomUUID()]) : stack.digest;
    const deploymentId = foreign ? `LOCAL_FOREIGN_FIXTURE_${randomUUID()}` : stack.manifest.deploymentId;
    return stack.repo.tx(async db => {
      await db.query(`INSERT INTO arco_evm."${quoteTable}" (id,"actorId",wallet,symbol,quantity,"cashAmount","deploymentDigest","expiresAt")
        SELECT $2,"actorId",wallet,symbol,quantity,"cashAmount",$3,clock_timestamp()-interval '1 second'
        FROM arco_evm."${quoteTable}" WHERE id=$1`, [source.quoteId, quoteId, deploymentDigest]);
      return (await db.query(`INSERT INTO arco_evm."${orderTable}" (id,"orderKey","quoteId","actorId",wallet,symbol,quantity,"cashAmount","idempotencyKey","deploymentId","deploymentDigest","quoteExpiresAt")
        SELECT $2,$3,$4,"actorId",wallet,symbol,quantity,"cashAmount",$5,$6,$7,
        (SELECT "expiresAt" FROM arco_evm."${quoteTable}" WHERE id=$4)
        FROM arco_evm."${orderTable}" WHERE id=$1 RETURNING *`, [source.id, id,
        operationKey(`${side === 'SELL' ? 'sell:' : ''}${stack.manifest.networkInstance}:${id}`), quoteId,
        `diagnostics-fixture:${id}`, deploymentId, deploymentDigest])).rows[0];
    });
  }
  for (const side of ['BUY', 'SELL']) {
    const historical = await insertedFixture(side, false);
    const expected = await capture(`${side}: historical NOT_ENROLLED expired order`, side, historical.id, 'EXPLICIT_HISTORICAL_DB_FIXTURE');
    assert.equal(expected.enrollment, 'NOT_ENROLLED'); assert.equal(expected.order.quoteExpired, true);
    assert.equal(expected.approval, null); assert.equal(expected.transfer, null);
    const foreign = await insertedFixture(side, true);
    await assert.rejects(diagnostics.inspect(side, foreign.id), error => error?.status === 404 && error?.message === 'ORDER_NOT_FOUND');
    foreignOrders.push({ side, orderId: foreign.id, provenance: 'EXPLICIT_FOREIGN_DEPLOYMENT_DB_FIXTURE', expectedStatus: 404 });
  }

  async function snapshotFacts() {
    // All Stocks tables, including other-deployment fixture rows and audit/
    // reservation/outbox facts. No API request logs or moving observation clocks.
    const tables = (await stack.pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='arco_evm'
      AND tablename LIKE 'Stocks%' ORDER BY tablename`)).rows.map(row => row.tablename);
    const database = {};
    for (const table of tables) {
      assert.match(table, /^Stocks[A-Za-z0-9_]+$/);
      database[table] = (await stack.pool.query(`SELECT to_jsonb(t) AS row FROM arco_evm."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    database.signerOperations = (await stack.pool.query('SELECT to_jsonb(t) AS row FROM stocks_local_harness.signer_operations t ORDER BY id')).rows;
    const block = await stack.chain.block('finalized');
    const [holderCash, holderStock, vaultCash, escrowStock, stockSupply] = await Promise.all([
      stack.chain.tokenBalance(stack.manifest.cashToken, stack.accounts.holder, block.number),
      stack.chain.tokenBalance(stack.manifest.stockToken, stack.accounts.holder, block.number),
      stack.chain.tokenBalance(stack.manifest.cashToken, stack.manifest.fundingVault, block.number),
      stack.chain.tokenBalance(stack.manifest.stockToken, stack.manifest.redemptionEscrow, block.number),
      stack.chain.tokenSupply(stack.manifest.stockToken, block.number),
    ]);
    const nonces = {};
    for (const address of [...new Set(Object.values(stack.accounts))].sort()) {
      nonces[address] = await stack.rpc('eth_getTransactionCount', [address, 'pending']);
    }
    return { database, chain: { blockNumber: block.number, blockHash: block.hash,
      holderCash, holderStock, vaultCash, escrowStock, stockSupply, nonces } };
  }
  return { cases, foreignOrders, fixtureSends, snapshotFacts,
    limitations: ['Normal fixture orders use production services, not investor browser buttons.',
      'Historical and foreign-deployment orders are explicitly inserted isolated DB fixtures.',
      'Reverted receipts are real local EVM out-of-gas executions; no public-chain failure is claimed.',
      'Captured quoteExpired values may naturally change; compare fresh diagnostics when checking expiry.'] };
}
