import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import type { Hex } from 'viem';
import { manifestDigest, type Actor, type SqlPool } from './contracts.js';
import { ReceiptVerifier } from './chain.js';
import { DIRECT_ORDER_PREFIX } from './direct.js';
import { StocksRepository } from './repository.js';
import { StocksService } from './service.js';
import { StocksWorker } from './worker.js';
import { createDurableMockBroker } from './mock-broker.js';
import { stocksPlugin } from './plugin.js';
import { readHeldPayments } from './held.js';
import { a, h, ACTOR, TestChain, TestSigner, testManifest, testTusdcManifest } from './test-fixtures.js';
import { StocksTradingLimitService } from '../stocks-trading-limits/service.js';

// The order paths with trading limits on, over the real Stocks schema: quotes and orders are refused, direct payments
// and escrows are held, and two orders at the cap never pass it together.
const require = createRequire(import.meta.url);
const enabled = process.env.STOCKS_TEST_HARNESS_ONLY === '1' && !!process.env.STOCKS_TEST_DATABASE_URL;
const options = { skip: !enabled };
const pg = require('pg') as { Pool: new (options: unknown) => SqlPool & { end(): Promise<void> } };
let nextPhysicalAddress = 40000;
const key = (n: number) => `${DIRECT_ORDER_PREFIX}${n.toString(16).padStart(48, '0')}` as Hex;
const WALLET = a(4343);
const CONTROL = { operatorId: 'limits-operator', permissions: ['stocks:read', 'stocks:control'] };
const USDC = (whole: number) => (BigInt(whole) * 1_000_000n).toString();

async function fixture(limited = true) {
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
  const digest = manifestDigest(m);
  const repo = new StocksRepository(pool, digest);
  const rpc = new TestChain(m);
  const signer = new TestSigner();
  let halted = false;
  const limits = new StocksTradingLimitService(pool, digest, ['NVDA']);
  const service = new StocksService(repo, m, new ReceiptVerifier(m, rpc), { manifestDigest: digest, contractPolicyVerified: true }, async () => halted, async () => true, async () => true, undefined, async () => halted, limited ? limits : undefined);
  const worker = new StocksWorker(service, createDurableMockBroker(repo), signer);
  const eligible = async () => { await pool.query('UPDATE arco_evm."StocksOutbox" SET "leaseUntil"=NULL,"nextAttemptAt"=clock_timestamp()-interval \'1 second\' WHERE "deploymentDigest"=$1 AND status NOT IN (\'DONE\',\'REVIEW\')', [digest]); };
  const versions = new Map<string, number>();
  /** Sets one (NVDA, side) the way the console does: the next version, a fresh key, a reason. */
  const set = async (side: 'BUY' | 'SELL', enabledSide: boolean, dailyCashLimit: string | null) => {
    const expectedVersion = versions.get(side) ?? 0;
    const change = await limits.change(CONTROL, 'NVDA', side, { enabled: enabledSide, dailyCashLimit, expectedVersion, idempotencyKey: `limit:${randomUUID()}`, reason: 'Test limit' });
    versions.set(side, change.state.version);
  };
  /** A direct Buy settled end to end, so the wallet holds NVDA it can sell. */
  const settledBuy = async (orderKey: Hex, cash: string, txHash: Hex) => {
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
  return { pool, m, digest, repo, rpc, service, limits, set, settledBuy, pause: (value: boolean) => { halted = value; } };
}
async function scenario(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, limited = true) {
  const f = await fixture(limited);
  try { await work(f); } finally { await f.pool.end(); }
}
const refused = (code: string) => (error: any) => error.code === code && error.status === 409;

test('LIMITS PG Buy quotes and orders: a disabled side refuses both, and a quote made before the switch cannot become an order', options, () => scenario(async (f) => {
  const actor: Actor = { ...ACTOR, actorId: randomUUID() };
  const early = await f.service.quoteForCash(actor, 'NVDA', '60');
  await f.set('BUY', false, null);
  await assert.rejects(() => f.service.quoteForCash(actor, 'NVDA', '60'), refused('SIDE_DISABLED'));
  await assert.rejects(() => f.service.quote(actor, 'NVDA', '1'), refused('SIDE_DISABLED'));
  await assert.rejects(() => f.service.createOrder(actor, early.id, `test:${randomUUID()}`), refused('SIDE_DISABLED'));
  assert.equal((await f.pool.query('SELECT 1 FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$1', [f.digest])).rows.length, 0);
  await f.set('BUY', true, null);
  const order = await f.service.createOrder(actor, (await f.service.quoteForCash(actor, 'NVDA', '60')).id, `test:${randomUUID()}`);
  assert.equal(order.state, 'AWAITING_FUNDING');
}));

test('LIMITS PG Buy daily cap: an order counts when it is created, the one past the cap is refused, and two at once never pass it together', options, () => scenario(async (f) => {
  const actor: Actor = { ...ACTOR, actorId: randomUUID() };
  await f.set('BUY', true, USDC(100));
  const first = await f.service.createOrder(actor, (await f.service.quoteForCash(actor, 'NVDA', '60')).id, `test:${randomUUID()}`);
  assert.equal(first.cashAmount, USDC(60));
  await assert.rejects(() => f.service.quoteForCash(actor, 'NVDA', '50'), refused('DAILY_LIMIT_REACHED'));
  const last = await f.service.quoteForCash(actor, 'NVDA', '40');
  await f.service.createOrder(actor, last.id, `test:${randomUUID()}`);
  await assert.rejects(() => f.service.quoteForCash(actor, 'NVDA', '0.000001'), refused('DAILY_LIMIT_REACHED'));
  // Raise the cap to 200: 100 used, room for one more 80, not two. Both quotes pass the hint; one order wins.
  await f.set('BUY', true, USDC(200));
  const [q1, q2] = [await f.service.quoteForCash(actor, 'NVDA', '80'), await f.service.quoteForCash(actor, 'NVDA', '80')];
  const outcomes = await Promise.allSettled([q1, q2].map(q => f.service.createOrder(actor, q.id, `test:${randomUUID()}`)));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const loser = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
  assert.equal(loser.reason.code, 'DAILY_LIMIT_REACHED');
  const used = (await f.pool.query('SELECT SUM("cashAmount")::text AS used FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$1', [f.digest])).rows[0].used;
  assert.equal(used, USDC(180));
}));

test('LIMITS PG direct Buy past the cap or on a disabled side is held without an order; a pause still comes first', options, () => scenario(async (f) => {
  await f.set('BUY', true, USDC(100));
  f.rpc.funding(key(1), USDC(60), WALLET, h(701));
  await f.service.observeFunding(h(701));
  assert.equal((await f.service.directOrder(key(1))).state, 'BROKER_PENDING');
  f.rpc.funding(key(2), USDC(50), WALLET, h(702));
  await f.service.observeFunding(h(702));
  const over = await f.service.directOrder(key(2));
  assert.deepEqual({ state: over.state, cashAmount: over.cashAmount, hold: over.hold }, { state: 'FUNDING_REVIEW_REQUIRED', cashAmount: USDC(50), hold: 'DAILY_LIMIT_REACHED' });
  await f.set('BUY', false, USDC(100));
  f.rpc.funding(key(3), USDC(10), WALLET, h(703));
  await f.service.observeFunding(h(703));
  assert.equal((await f.service.directOrder(key(3))).hold, 'SIDE_DISABLED');
  f.pause(true);
  f.rpc.funding(key(4), USDC(10), WALLET, h(704));
  await f.service.observeFunding(h(704));
  assert.equal((await f.service.directOrder(key(4))).hold, 'TRADING_PAUSED');
  const held = (await f.pool.query('SELECT status,reason FROM arco_evm."StocksFunding" WHERE "txHash"=ANY($1) ORDER BY "txHash"', [[h(702), h(703), h(704)]])).rows;
  assert.deepEqual(held, Array(3).fill({ status: 'SUSPENSE', reason: 'UNIDENTIFIED_ORDER' }));
  const list = await readHeldPayments(f.repo, { limit: 10, cursor: null });
  assert.deepEqual(list.items.map(item => item.hold).sort(), ['DAILY_LIMIT_REACHED', 'SIDE_DISABLED', 'TRADING_PAUSED']);
  assert.equal((await f.pool.query('SELECT 1 FROM arco_evm."StocksOrder" WHERE "deploymentDigest"=$1', [f.digest])).rows.length, 1, 'only the first deposit became an order');
}));

test('LIMITS PG Sell: quotes, orders and direct escrows follow the sell side, whatever the buy side says', options, () => scenario(async (f) => {
  await f.settledBuy(key(10), USDC(120), h(710));
  const seller: Actor = { ...ACTOR, actorId: randomUUID(), wallet: WALLET };
  await f.set('BUY', false, null);
  const quote = await f.service.sell.quote(seller, 'NVDA', '0.4');
  await f.set('SELL', true, USDC(10));
  await assert.rejects(() => f.service.sell.createOrder(seller, quote.id, `test:${randomUUID()}`), refused('DAILY_LIMIT_REACHED'));
  await assert.rejects(() => f.service.sell.quote(seller, 'NVDA', '0.4'), refused('DAILY_LIMIT_REACHED'));
  const small = await f.service.sell.createOrder(seller, (await f.service.sell.quote(seller, 'NVDA', '0.05')).id, `test:${randomUUID()}`);
  assert.equal(small.state, 'AWAITING_ESCROW');
  const over = f.rpc.escrow(key(11), '400000000', WALLET, h(711));
  await f.service.sell.observeEscrow(over.txHash);
  const heldOver = await f.service.directOrder(key(11));
  assert.deepEqual({ side: heldOver.side, state: heldOver.state, hold: heldOver.hold }, { side: 'SELL', state: 'ESCROW_REVIEW_REQUIRED', hold: 'DAILY_LIMIT_REACHED' });
  await f.set('SELL', false, null);
  await assert.rejects(() => f.service.sell.quote(seller, 'NVDA', '0.01'), refused('SIDE_DISABLED'));
  const disabled = f.rpc.escrow(key(12), '10000000', WALLET, h(712));
  await f.service.sell.observeEscrow(disabled.txHash);
  assert.equal((await f.service.directOrder(key(12))).hold, 'SIDE_DISABLED');
  const custody = (await f.pool.query('SELECT status,"orderId" FROM arco_evm."StocksCustody" WHERE "txHash"=ANY($1)', [[h(711), h(712)]])).rows;
  assert.deepEqual(custody, Array(2).fill({ status: 'HELD', orderId: null }));
}));

test('LIMITS PG availability tells a wallet, before it sends, whether a side and amount would be taken; the catalog is unchanged', options, async () => {
  await scenario(async (f) => {
    const app = Fastify();
    await app.register(stocksPlugin, { service: f.service });
    const ask = async (query: string) => { const r = await app.inject({ url: `/api/v1/stocks/availability?${query}` }); return { status: r.statusCode, body: r.json() }; };
    try {
      assert.deepEqual((await ask('side=BUY')).body.data, { symbol: 'NVDA', side: 'BUY', accepts: true, block: null });
      await f.set('SELL', false, null);
      await f.set('BUY', true, USDC(100));
      f.rpc.funding(key(20), USDC(60), WALLET, h(720));
      await f.service.observeFunding(h(720));
      assert.equal((await ask(`side=BUY&cashAmount=${USDC(40)}`)).body.data.accepts, true);
      assert.deepEqual((await ask(`side=BUY&cashAmount=${USDC(41)}`)).body.data, { symbol: 'NVDA', side: 'BUY', accepts: false, block: 'DAILY_LIMIT_REACHED' });
      assert.equal((await ask('side=SELL')).body.data.block, 'SIDE_DISABLED');
      f.pause(true);
      assert.equal((await ask('side=BUY')).body.data.block, 'TRADING_PAUSED', 'a pause comes first');
      for (const bad of ['', 'side=HOLD', 'side=BUY&cashAmount=0', 'side=BUY&cashAmount=1.5', 'side=BUY&cashAmount=-1', 'side=BUY&extra=1']) assert.equal((await ask(bad)).status, 400, bad);
      const catalog = (await app.inject({ url: '/api/v1/stocks/catalog' })).json();
      assert.deepEqual(Object.keys(catalog.instruments[0]).sort(), ['orderCapability', 'price', 'priceSource', 'quantityScale', 'symbol', 'tokenAddress']);
    } finally { await app.close(); }
  });
  await scenario(async (f) => {
    await f.set('BUY', false, null);
    assert.deepEqual(await f.service.tradingAvailability('BUY', undefined), { symbol: 'NVDA', side: 'BUY', accepts: true, block: null });
    const actor: Actor = { ...ACTOR, actorId: randomUUID() };
    const order = await f.service.createOrder(actor, (await f.service.quoteForCash(actor, 'NVDA', '60')).id, `test:${randomUUID()}`);
    assert.equal(order.state, 'AWAITING_FUNDING', 'a stored limit does nothing while the service runs without the limits');
  }, false);
});
