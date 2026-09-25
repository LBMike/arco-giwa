import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import type { Hex } from 'viem';
import { ensure, manifestDigest, type SqlPool } from './contracts.js';
import { ReceiptVerifier } from './chain.js';
import { DIRECT_ORDER_PREFIX, directActorId } from './direct.js';
import { StocksRepository } from './repository.js';
import { StocksService } from './service.js';
import { StocksWorker } from './worker.js';
import { createDurableMockBroker } from './mock-broker.js';
import { stocksPlugin } from './plugin.js';
import { a, h, TestChain, TestSigner, testManifest, testTusdcManifest } from './test-fixtures.js';
import type { StocksPricing } from './pricing.js';

// Direct orders over the real Stocks schema: the wallet's own deposit (Buy) or escrow (Sell) is the order.
const require = createRequire(import.meta.url);
const enabled = process.env.STOCKS_TEST_HARNESS_ONLY === '1' && !!process.env.STOCKS_TEST_DATABASE_URL;
const options = { skip: !enabled };
const pg = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void> } };
let nextPhysicalAddress = 20000;
const key = (n: number) => `${DIRECT_ORDER_PREFIX}${n.toString(16).padStart(48, '0')}` as Hex;
const WALLET = a(4242);

async function fixture(pricing?: StocksPricing) {
  const pool = new pg.Pool({ connectionString: process.env.STOCKS_TEST_DATABASE_URL, max: 8 });
  const m = process.env.STOCKS_TEST_EXTERNAL_CASH_ONLY === '1' ? testTusdcManifest() : testManifest();
  m.deploymentId = `TEST_HARNESS_ONLY_${randomUUID()}`;
  m.networkInstance = `TEST_NETWORK_${randomUUID()}`;
  for (const field of (m.schemaVersion === 3 ? ['fundingVault'] : ['cashToken', 'fundingVault']) as ('cashToken' | 'fundingVault')[]) {
    const previous = m[field];
    m[field] = a(nextPhysicalAddress++);
    m.codeHashes[m[field]] = m.codeHashes[previous];
    delete m.codeHashes[previous];
  }
  const repo = new StocksRepository(pool, manifestDigest(m));
  const rpc = new TestChain(m);
  const signer = new TestSigner();
  // `halted` is an explicit halt (operator or configured pause); `delayed` only holds dispatch (observer health).
  let halted = false;
  let delayed = false;
  const service = new StocksService(repo, m, new ReceiptVerifier(m, rpc), { manifestDigest: manifestDigest(m), contractPolicyVerified: true }, async () => halted || delayed, async () => true, async () => true, pricing, async () => halted);
  const worker = new StocksWorker(service, createDurableMockBroker(repo), signer);
  const eligible = async () => { await pool.query('UPDATE arco_evm."StocksOutbox" SET "leaseUntil"=NULL,"nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE "deploymentDigest"=$1 AND status NOT IN (\'DONE\',\'REVIEW\')', [repo.deploymentDigest]); };
  /** A direct Buy settled end to end: deposit, broker, mint, confirmation. */
  const buy = async (orderKey: Hex, cash: string, txHash: Hex) => {
    rpc.funding(orderKey, cash, WALLET, txHash);
    await service.observeFunding(txHash);
    await worker.runOne();
    await worker.runOne();
    const call = signer.calls[signer.calls.length - 1]!;
    const status = await service.directOrder(orderKey);
    rpc.confirmation(call, status.quantity, WALLET, 'MINT', signer.receipts.get(call.operationId)!.txHash);
    await eligible();
    await worker.runOne();
    rpc.cashBalance = (BigInt(rpc.cashBalance) + BigInt(cash)).toString();
    rpc.stockSupply = (BigInt(rpc.stockSupply) + BigInt(status.quantity)).toString();
    rpc.walletBalances[WALLET] = (BigInt(rpc.walletBalances[WALLET] ?? '0') + BigInt(status.quantity)).toString();
    return service.directOrder(orderKey);
  };
  return { pool, m, repo, rpc, signer, service, worker, eligible, buy, pause: (value: boolean) => { halted = value; }, delay: (value: boolean) => { delayed = value; } };
}
async function scenario(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, pricing?: StocksPricing) {
  const f = await fixture(pricing);
  try { await work(f); } finally { await f.pool.end(); }
}

test('DIRECT PG Buy: the deposit is the order, priced when observed, minted to the paying wallet; a replay creates nothing', options, async () => scenario(async (f) => {
  const done = await f.buy(key(1), '60000000', h(501));
  assert.deepEqual({ side: done.side, state: done.state, quantity: done.quantity, cashAmount: done.cashAmount }, { side: 'BUY', state: 'COMPLETED', quantity: '500000000', cashAmount: '60000000' });
  const orders = await f.repo.scopedOrders(directActorId(WALLET));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderKey, key(1));
  assert.equal(orders[0].wallet, WALLET);
  const funding = (await f.pool.query('SELECT status,reason FROM arco_evm."StocksFunding" WHERE "orderId"=$1', [orders[0].id])).rows;
  assert.deepEqual(funding, [{ status: 'ACCEPTED', reason: 'EXACT_PAYMENT' }]);
  await f.service.observeFunding(h(501));
  assert.equal((await f.repo.scopedOrders(directActorId(WALLET))).length, 1, 'observing the same deposit again creates no second order');
  const audit = (await f.pool.query('SELECT detail FROM arco_evm."StocksAudit" WHERE subject=$1 AND action=\'DIRECT_ORDER_CREATED\'', [orders[0].id])).rows;
  assert.equal(audit[0].detail.price, '120.000000');
}));

let livePrice = 200_000_000n;
test('DIRECT PG Buy uses the live price of the moment and the mint fee; amounts that buy nothing and paused trading are held for review', options, async () => scenario(async (f) => {
  const live = await f.buy(key(2), '100000000', h(502));
  // 100 tUSDC at 200.00 less a 1% mint fee: 0.495 NVDA.
  assert.equal(live.quantity, '495000000');
  // At 2,000.00 one base unit of tUSDC buys less than one base unit of NVDA.
  livePrice = 2_000_000_000n;
  f.rpc.funding(key(3), '1', WALLET, h(503));
  await f.service.observeFunding(h(503));
  const tiny = await f.service.directOrder(key(3));
  assert.deepEqual({ state: tiny.state, cashAmount: tiny.cashAmount, hold: tiny.hold }, { state: 'FUNDING_REVIEW_REQUIRED', cashAmount: '1', hold: 'BELOW_ONE_UNIT' });
  f.pause(true);
  f.rpc.funding(key(4), '60000000', WALLET, h(504));
  await f.service.observeFunding(h(504));
  const paused = await f.service.directOrder(key(4));
  assert.deepEqual({ state: paused.state, cashAmount: paused.cashAmount, hold: paused.hold }, { state: 'FUNDING_REVIEW_REQUIRED', cashAmount: '60000000', hold: 'TRADING_PAUSED' });
  const held = (await f.pool.query('SELECT status,reason FROM arco_evm."StocksFunding" WHERE "txHash"=ANY($1) ORDER BY "txHash"', [[h(503), h(504)]])).rows;
  assert.deepEqual(held, [{ status: 'SUSPENSE', reason: 'UNIDENTIFIED_ORDER' }, { status: 'SUSPENSE', reason: 'UNIDENTIFIED_ORDER' }]);
}, { price: async () => livePrice, mintFeeBps: 100n, burnFeeBps: 0n }));

test('DIRECT PG a deposit seen while only dispatch waits (observer catching up) becomes its order, and settles once dispatch resumes', options, async () => scenario(async (f) => {
  f.delay(true);
  f.rpc.funding(key(40), '60000000', WALLET, h(540));
  await f.service.observeFunding(h(540));
  const waiting = await f.service.directOrder(key(40));
  assert.deepEqual({ state: waiting.state, quantity: waiting.quantity, hold: waiting.hold }, { state: 'BROKER_PENDING', quantity: '500000000', hold: undefined });
  await f.worker.runOne();
  assert.equal(f.signer.calls.length, 0, 'nothing is dispatched while dispatch waits');
  assert.equal((await f.service.directOrder(key(40))).state, 'BROKER_PENDING');
  f.delay(false);
  await f.eligible();
  await f.worker.runOne();
  await f.worker.runOne();
  const call = f.signer.calls[f.signer.calls.length - 1]!;
  f.rpc.confirmation(call, '500000000', WALLET, 'MINT', f.signer.receipts.get(call.operationId)!.txHash);
  await f.eligible();
  await f.worker.runOne();
  assert.equal((await f.service.directOrder(key(40))).state, 'COMPLETED');
}));

let priceReadable = false;
test('DIRECT PG an unreadable price makes the observer read a recent deposit again, and holds one older than the wait for review', options, async () => scenario(async (f) => {
  f.rpc.funding(key(30), '60000000', WALLET, h(530));
  await assert.rejects(() => f.service.observeFunding(h(530)), /PRICE_UNAVAILABLE/);
  assert.equal((await f.pool.query('SELECT 1 FROM arco_evm."StocksFunding" WHERE "txHash"=$1', [h(530)])).rows.length, 0, 'nothing is recorded, so the observer reads the deposit again');
  await assert.rejects(() => f.service.directOrder(key(30)), /DIRECT_ORDER_NOT_FOUND/);
  priceReadable = true;
  await f.service.observeFunding(h(530));
  assert.equal((await f.service.directOrder(key(30))).state, 'BROKER_PENDING');
  priceReadable = false;
  f.rpc.funding(key(31), '60000000', WALLET, h(531), String(Math.floor(Date.now() / 1000) - 601));
  await f.service.observeFunding(h(531));
  const held = await f.service.directOrder(key(31));
  assert.deepEqual({ state: held.state, cashAmount: held.cashAmount, hold: held.hold }, { state: 'FUNDING_REVIEW_REQUIRED', cashAmount: '60000000', hold: 'PRICE_UNAVAILABLE' });
}, { price: async () => { ensure(priceReadable, 'PRICE_UNAVAILABLE', 503); return 120_000_000n; }, mintFeeBps: 0n, burnFeeBps: 0n }));

test('DIRECT PG an unknown key without the direct prefix stays in suspense as before', options, async () => scenario(async (f) => {
  f.rpc.funding(h(777), '60000000', WALLET, h(505));
  const row = await f.service.observeFunding(h(505)) as Record<string, any>;
  assert.equal(row.status, 'SUSPENSE');
  assert.equal(row.reason, 'UNIDENTIFIED_ORDER');
  assert.equal((await f.repo.scopedOrders(directActorId(WALLET))).length, 0);
  await assert.rejects(() => f.service.directOrder(h(777)), /INVALID_DIRECT_ORDER_KEY/);
}));

test('DIRECT PG Sell: the escrow is the order, paid out at the price of the moment to the escrowing wallet', options, async () => scenario(async (f) => {
  await f.buy(key(10), '120000000', h(510));
  const raw = f.rpc.escrow(key(11), '400000000', WALLET, h(511));
  const custody = await f.service.sell.observeEscrow(raw.txHash) as Record<string, any>;
  assert.equal(custody.reason, 'EXACT_ESCROW');
  const created = await f.service.directOrder(key(11));
  assert.deepEqual({ side: created.side, quantity: created.quantity, cashAmount: created.cashAmount }, { side: 'SELL', quantity: '400000000', cashAmount: '48000000' });
  await f.worker.runOne();
  await f.worker.runOne();
  const call = f.signer.calls[f.signer.calls.length - 1]!;
  f.rpc.redeem(call, raw.escrowId, '400000000', '48000000', WALLET, 'REDEEM', f.signer.receipts.get(call.operationId)!.txHash);
  await f.eligible();
  await f.worker.runOne();
  assert.equal((await f.service.directOrder(key(11))).state, 'COMPLETED');
  const orders = await f.repo.sellOrders(directActorId(WALLET));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderKey, key(11));
  await f.service.sell.observeEscrow(raw.txHash);
  assert.equal((await f.repo.sellOrders(directActorId(WALLET))).length, 1, 'observing the same escrow again creates no second order');
  f.pause(true);
  const paused = f.rpc.escrow(key(12), '100000000', WALLET, h(512));
  await f.service.sell.observeEscrow(paused.txHash);
  const held = await f.service.directOrder(key(12));
  assert.deepEqual({ side: held.side, state: held.state, quantity: held.quantity, hold: held.hold }, { side: 'SELL', state: 'ESCROW_REVIEW_REQUIRED', quantity: '100000000', hold: 'TRADING_PAUSED' });
}));

test('DIRECT PG status route is public, validates the key and answers 404 before the observer sees the transaction', options, async () => scenario(async (f) => {
  const app = Fastify();
  await app.register(stocksPlugin, { service: f.service });
  try {
    assert.equal((await app.inject({ url: `/api/v1/stocks/direct/${key(20)}` })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/v1/stocks/direct/0x1234' })).statusCode, 400);
    await f.buy(key(20), '60000000', h(520));
    const answer = await app.inject({ url: `/api/v1/stocks/direct/${key(20)}` });
    assert.equal(answer.statusCode, 200);
    const data = answer.json().data;
    assert.deepEqual({ side: data.side, state: data.state, quantity: data.quantity, cashAmount: data.cashAmount }, { side: 'BUY', state: 'COMPLETED', quantity: '500000000', cashAmount: '60000000' });
    const catalog = (await app.inject({ url: '/api/v1/stocks/catalog' })).json();
    assert.deepEqual(catalog.contracts, { cashToken: f.m.cashToken.toLowerCase(), fundingVault: f.m.fundingVault.toLowerCase(), stockToken: f.m.stockToken.toLowerCase(), redemptionEscrow: f.m.redemptionEscrow.toLowerCase() });
  } finally { await app.close(); }
}));

test('DIRECT PG wallet activity: paid or escrowed trades with their GIWA transactions, newest first; held payments too; never another wallet', options, async () => scenario(async (f) => {
  const other = a(4343);
  await f.buy(key(60), '60000000', h(560));
  const mint = f.signer.calls[f.signer.calls.length - 1]!;
  const mintTx = f.signer.receipts.get(mint.operationId)!.txHash;
  const raw = f.rpc.escrow(key(61), '100000000', WALLET, h(561));
  await f.service.sell.observeEscrow(raw.txHash);
  await f.worker.runOne();
  await f.worker.runOne();
  const redeem = f.signer.calls[f.signer.calls.length - 1]!;
  const redeemTx = f.signer.receipts.get(redeem.operationId)!.txHash;
  f.rpc.redeem(redeem, raw.escrowId, '100000000', '12000000', WALLET, 'REDEEM', redeemTx);
  await f.eligible();
  await f.worker.runOne();
  assert.equal((await f.service.directOrder(key(61))).state, 'COMPLETED');
  f.pause(true);
  f.rpc.funding(key(62), '5000000', WALLET, h(562));
  await f.service.observeFunding(h(562));
  f.rpc.funding(key(63), '7000000', other, h(563));
  await f.service.observeFunding(h(563));
  f.pause(false);
  const activity = await f.service.walletActivity(`0x${WALLET.slice(2).toUpperCase()}`);
  assert.deepEqual(activity.map((e) => [e.side, e.state, e.quantity, e.cashAmount, e.paymentTx, e.settlementTx]), [
    ['BUY', 'FUNDING_REVIEW_REQUIRED', '0', '5000000', h(562), null],
    ['SELL', 'COMPLETED', '100000000', '12000000', h(561), redeemTx],
    ['BUY', 'COMPLETED', '500000000', '60000000', h(560), mintTx],
  ]);
  assert.ok(activity.every((e) => /^\d{4}-\d{2}-\d{2}T/.test(e.createdAt)));
  assert.deepEqual((await f.service.walletActivity(other)).map((e) => e.paymentTx), [h(563)]);
  assert.deepEqual(await f.service.walletActivity(a(4444)), []);
  await assert.rejects(() => f.service.walletActivity('0x1234'), /INVALID_WALLET/);
  const app = Fastify();
  await app.register(stocksPlugin, { service: f.service });
  try {
    assert.equal((await app.inject({ url: '/api/v1/stocks/activity/0x1234' })).statusCode, 400);
    const answer = await app.inject({ url: `/api/v1/stocks/activity/${WALLET}` });
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.json().data.length, 3);
  } finally { await app.close(); }
}));
