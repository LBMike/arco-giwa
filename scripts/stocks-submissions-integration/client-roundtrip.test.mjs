import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';
import { buildApp } from '../../server/dist/app.js';
import { StocksRepository } from '../../server/dist/stocks/repository.js';
import { StocksService } from '../../server/dist/stocks/service.js';
import { ReceiptVerifier } from '../../server/dist/stocks/chain.js';
import { testManifest, TestChain, a, h } from '../../server/dist/stocks/test-fixtures.js';
import { createSubmissionReceiptVerifier } from '../../server/dist/stocks-submissions/receipts.js';
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { manifestDigest } from '../../server/dist/stocks/contracts.js';
import { StocksSubmissionsService } from '../../server/dist/stocks-submissions/service.js';
import { stocksSessionResolvers } from '../../server/dist/stocks-runtime/session.js';
const { createSubmissionGate } = await tsImport('../../src/demo/giwa/stocks-wallet-submissions/client.ts', import.meta.url);
const { createStocksWalletController } = await tsImport('../../src/demo/giwa/stocks-wallet/controller.ts', import.meta.url);
const { planOrder, digest } = await tsImport('../../src/demo/giwa/stocks-wallet/planner.ts', import.meta.url);
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const { sign } = require('jsonwebtoken');
const enabled = process.env.STOCKS_TEST_HARNESS_ONLY === '1' && process.env.STOCKS_TEST_DATABASE_URL;
assert.ok(enabled, 'This test requires an explicitly owned fresh PostgreSQL harness');
const domain = 'submission-roundtrip.test';
const env = { corsAllowedOrigins: [`https://${domain}`], authNonceTtlSeconds: 60, authJwtSecret: 'LOCAL_ROUNDTRIP_TEST_ONLY', adminOperatorToken: 'LOCAL_UNUSED_OPERATOR', registryPath: '/NO_DEPLOYED_REGISTRY' };
async function scenario(run, side = 'BUY') {
  const pool = new Pool({ connectionString: process.env.STOCKS_TEST_DATABASE_URL, max: 8 });
  let app;
  try {
  const manifest = testManifest();
  manifest.deploymentId = `TEST_${randomUUID()}`;
  manifest.networkInstance = `TEST_${randomUUID()}`;
  // Every scenario owns a distinct physical vault; never mutate a prior binding.
  const old = manifest.fundingVault;
  manifest.fundingVault = `0x${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 40)}`;
  manifest.codeHashes[manifest.fundingVault] = manifest.codeHashes[old]; delete manifest.codeHashes[old];
  const deploymentDigest = manifestDigest(manifest), wallet = a(42);
  const actor = { actorId: `evm:${wallet}`, wallet, chainId: 91342, scope: 'STOCKS_TESTNET', verified: true };
  const chain = new TestChain(manifest);
  const stocks = new StocksService(new StocksRepository(pool, deploymentDigest), manifest, new ReceiptVerifier(manifest, chain), { manifestDigest: deploymentDigest, contractPolicyVerified: true }, async () => false);
  if (side === 'SELL') await pool.query('INSERT INTO arco_evm."StocksQuantityMovement" (id,"deploymentDigest",wallet,"walletDelta","escrowDelta","supplyDelta","blockNumber","blockHash","txHash") VALUES ($1,$2,$3,1000000000,0,1000000000,1,$4,$5)', [randomUUID(), deploymentDigest, wallet, 'fixture-block', 'fixture-tx']);
  const orderService = side === 'BUY' ? stocks : stocks.sell;
  const quote = await orderService.quote(actor, 'NVDA', '1');
  const order = JSON.parse(JSON.stringify(await orderService.createOrder(actor, quote.id, `key:${randomUUID()}`)));
  const now = Date.now();
  const session = { id: randomUUID(), walletAddress: wallet, chainId: 91342, accessToken: sign({ sub: wallet, domain, chainId: 91342 }, env.authJwtSecret, { expiresIn: '15m' }), createdAt: now - 1000, expiresAt: now + 600000 };
  const context = { session, walletAddress: wallet, chainId: 91342, walletEpoch: 'TEST1', apiBase: `https://${domain}`, deployment: { status: 'VERIFIED', evidenceId: 'TEST_ONLY', manifestDigest: deploymentDigest, manifest, verifiedAt: now - 1000, validUntil: now + 600000 } };
  const plan = planOrder({ side, order }, context, now);
  app = buildApp(env, { arco: {}, registry: {}, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) }, stocks: { service: stocks, ...stocksSessionResolvers(env.authJwtSecret, [domain], []) }, stocksSubmissions: { service: new StocksSubmissionsService(stocks, createSubmissionReceiptVerifier(manifest, chain)), ...stocksSessionResolvers(env.authJwtSecret, [domain], []) } });
  const calls = [];
  const transport = async (url, init) => {
    const request = new URL(String(url)); calls.push(request.pathname);
    const result = await app.inject({ method: init.method, url: request.pathname + request.search, headers: init.headers, payload: init.body });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  };
  const client = (fetcher = transport, owner = session) => createSubmissionGate({ apiBase: context.apiBase, session: owner, side, orderId: order.id, deploymentDigest, fetch: fetcher });
  const claim = stage => { const transaction = stage === 'APPROVAL' ? plan.approval : plan.transfer; return { intentKey: plan.intentKey, stage, transaction, transactionDigest: digest(transaction), orderId: order.id, deploymentDigest }; };
  await run({ pool, app, stocks, order, session, plan, client, claim, transport, calls, context, chain, manifest, side });
  } finally { await app?.close(); await pool.end(); }
}
test('real app + PostgreSQL + browser adapter: lost claim response stays blocked across client recreation', async () => scenario(async f => {
  let dropped = false;
  const first = f.client(async (url, init) => { const response = await f.transport(url, init); if (String(url).endsWith('/claims') && !dropped) { dropped = true; throw new Error('SIMULATED_RESPONSE_LOSS_AFTER_COMMIT'); } return response; });
  await assert.rejects(() => first.claim(f.claim('TRANSFER')));
  const recovered = f.client();
  const prior = await recovered.inspect(f.plan.intentKey);
  assert.equal(prior.transfer.status, 'REQUEST_MAY_START');
  assert.equal(await recovered.claim(f.claim('TRANSFER')), null);
  await recovered.record({ ...prior.transfer, status: 'SUBMITTED', txHash: h(678) });
  const recreated = f.client();
  const persisted = await recreated.inspect(f.plan.intentKey);
  assert.equal(persisted.transfer.txHash, h(678));
  const { txHash: ignoredHash, ...withoutHash } = persisted.transfer;
  await recreated.record({ ...withoutHash, status: 'UNKNOWN' });
  assert.equal((await recreated.inspect(f.plan.intentKey)).transfer.txHash, h(678));
  await assert.rejects(() => recreated.record({ ...persisted.transfer, status: 'CONFIRMED' }));
  assert.equal(await recreated.claim(f.claim('TRANSFER')), null);
}));
test('real app + PostgreSQL + browser adapter: simultaneous clients receive one permission; other wallet cannot inspect', async () => scenario(async f => {
  const results = await Promise.all(Array.from({ length: 6 }, () => f.client().claim(f.claim('APPROVAL'))));
  assert.equal(results.filter(Boolean).length, 1);
  const blocked = await Promise.allSettled([f.client().claim(f.claim('TRANSFER'))]);
  if (blocked[0].status === 'fulfilled') assert.equal(blocked[0].value, null);
  assert.equal((await f.client().inspect(f.plan.intentKey)).transfer, null);
  const other = { ...f.session, id: randomUUID(), walletAddress: a(43), accessToken: sign({ sub: a(43), domain, chainId: 91342 }, env.authJwtSecret, { expiresIn: '15m' }) };
  await assert.rejects(() => f.client(undefined, other).inspect(f.plan.intentKey));
}));

// The HTTP application, authentication, browser adapter and PostgreSQL are real.
// ChainPort and wallet ports here are explicit deterministic fixtures, not a live EVM.
const approvalAbi = parseAbi(['event Approval(address indexed owner,address indexed spender,uint256 value)']);
function addApproval(f, hash, status = 'success') {
  const tx = f.plan.approval;
  f.chain.add({ hash, from: tx.from, to: tx.to, input: tx.data, value: tx.value }, [{
    address: f.plan.token,
    topics: encodeEventTopics({ abi: approvalAbi, eventName: 'Approval', args: { owner: tx.from, spender: f.plan.spender } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(f.plan.amount)]), logIndex: 0, removed: false,
  }]);
  f.chain.receipts.get(hash).status = status;
  if (status === 'reverted') f.chain.receipts.get(hash).logs = [];
}
function reconcileRequest(row) {
  return { claimId: row.claimId, intentKey: row.intentKey, stage: row.stage, transactionDigest: row.transactionDigest, txHash: row.txHash };
}
for (const side of ['BUY', 'SELL']) {
  test(`${side}: real API + browser + PG persists trusted approval then transfer; late outcomes cannot downgrade`, async () => scenario(async f => {
    const gate = f.client();
    const approval = await gate.claim(f.claim('APPROVAL'));
    const submitted = { ...approval, status: 'SUBMITTED', txHash: h(780) };
    await gate.record(submitted);
    assert.equal((await gate.reconcile(reconcileRequest(submitted))).status, 'SUBMITTED');
    await assert.rejects(() => gate.claim(f.claim('TRANSFER')));
    addApproval(f, submitted.txHash);
    const responses = await Promise.all(Array.from({ length: 4 }, () => gate.reconcile(reconcileRequest(submitted))));
    assert.ok(responses.every(row => row.status === 'CONFIRMED'));
    await gate.record({ ...approval, status: 'UNKNOWN' });
    const recreated = f.client();
    const stored = await recreated.inspect(f.plan.intentKey);
    assert.equal(stored.approval.status, 'CONFIRMED');
    assert.equal(stored.approval.txHash, submitted.txHash);
    assert.equal(await recreated.claim(f.claim('APPROVAL')), null);
    const transfer = await recreated.claim(f.claim('TRANSFER'));
    assert.equal(transfer.status, 'REQUEST_MAY_START');
    const transferred = { ...transfer, status: 'SUBMITTED', txHash: h(781) };
    await recreated.record(transferred);
    if (side === 'BUY') f.chain.funding(f.order.orderKey, f.order.cashAmount, f.order.wallet, transferred.txHash);
    else f.chain.escrow(f.order.orderKey, f.order.quantity, f.order.wallet, transferred.txHash);
    assert.equal((await recreated.reconcile(reconcileRequest(transferred))).status, 'CONFIRMED');
    assert.equal(await f.client().claim(f.claim('TRANSFER')), null);
    const table = side === 'BUY' ? 'StocksOrder' : 'StocksSellOrder';
    const actual = (await f.pool.query(`SELECT state FROM arco_evm."${table}" WHERE id=$1`, [f.order.id])).rows[0];
    assert.equal(actual.state, side === 'BUY' ? 'AWAITING_FUNDING' : 'AWAITING_ESCROW', 'wallet receipt must not masquerade as order settlement');
  }, side));

  test(`${side}: recreated controller recovers pending approval through server and requires a separate transfer click`, async () => scenario(async f => {
    let allowance = '0';
    const sent = [];
    const get = async path => {
      const result = await f.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${f.session.accessToken}` } });
      assert.equal(result.statusCode, 200); return result.json();
    };
    const ports = () => ({
      context: () => f.context,
      readWallet: async () => ({ address: f.order.wallet, chainId: 91342, connectionEpoch: f.context.walletEpoch, deploymentDigest: f.order.deploymentDigest, networkInstance: f.manifest.networkInstance, checkpointHash: f.manifest.checkpointHash }),
      readOrder: async () => get(`/api/v1/stocks/${side === 'BUY' ? 'orders' : 'sell-orders'}/${f.order.id}`),
      readCatalog: async () => get('/api/v1/stocks/catalog'),
      readExecutionPolicy: async () => ({ allowed: true, deploymentDigest: f.order.deploymentDigest, orderId: f.order.id, side, observedAt: Date.now(), validUntil: Date.now() + 15000 }),
      readAllowance: async () => allowance,
      requestTransaction: async tx => { sent.push(tx); return h(800 + sent.length); },
      waitApprovalReceipt: async () => { throw new Error('CLIENT_RECEIPT_MUST_NOT_BE_AUTHORITY'); },
      submissions: f.client(),
    });
    const first = createStocksWalletController(ports());
    first.select({ side, order: f.order });
    try {
      await first.prepare(); assert.equal(first.getSnapshot().status, 'APPROVAL_REQUIRED');
      await first.approve(); assert.equal(first.getSnapshot().status, 'APPROVAL_SUBMITTED');
      assert.equal(sent.length, 1); assert.deepEqual(sent[0], f.plan.approval);
    } finally { first.dispose(); }
    addApproval(f, h(801)); allowance = f.plan.amount;
    const second = createStocksWalletController(ports()); second.select({ side, order: f.order });
    try {
      await second.prepare(); assert.equal(second.getSnapshot().status, 'READY_TRANSFER');
      assert.equal(sent.length, 1, 'recovery must not send anything');
      await second.submit(); assert.equal(sent.length, 2); assert.deepEqual(sent[1], f.plan.transfer);
      assert.equal(second.getSnapshot().status, 'SUBMITTED');
      await second.prepare(); await second.submit(); assert.equal(sent.length, 2, 'existing transfer prevents resubmission');
    } finally { second.dispose(); }
  }, side));
}

test('real authenticated reconcile rejects spoofed proof, owner, and hash; reverted approval never unlocks transfer', async () => scenario(async f => {
  const gate = f.client(), approval = await gate.claim(f.claim('APPROVAL'));
  const submitted = { ...approval, status: 'SUBMITTED', txHash: h(900) };
  await gate.record(submitted);
  const request = reconcileRequest(submitted), url = '/api/v1/stocks/wallet-submissions/reconcile';
  const post = (payload, accessToken = f.session.accessToken) => f.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${accessToken}` }, payload });
  assert.equal((await post(request, env.adminOperatorToken)).statusCode, 401);
  const other = sign({ sub: a(43), domain, chainId: 91342 }, env.authJwtSecret, { expiresIn: '15m' });
  assert.equal((await post(request, other)).statusCode, 404);
  assert.notEqual((await post({ ...request, proof: { status: 'success' } })).statusCode, 200);
  assert.notEqual((await post({ ...request, txHash: h(901) })).statusCode, 200);
  assert.equal((await f.client().inspect(f.plan.intentKey)).approval.status, 'SUBMITTED');
  addApproval(f, submitted.txHash, 'reverted');
  assert.equal((await gate.reconcile(request)).status, 'REVERTED');
  await gate.record({ ...approval, status: 'UNKNOWN' });
  assert.equal((await f.client().inspect(f.plan.intentKey)).approval.status, 'REVERTED');
  await assert.rejects(() => gate.claim(f.claim('TRANSFER')));
  assert.equal(await gate.claim(f.claim('APPROVAL')), null);
}));
